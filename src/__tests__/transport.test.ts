import { describe, expect, it, vi } from 'vitest';

import { MessageType } from '../types.js';
import { createTransport, readQueryParam, resolveParentOrigin } from '../transport.js';
import type { BridgeMessage, ProxyResponsePayload } from '../types.js';

/**
 * Smoke tests for the transport. No real `window` — the listener-attach seam
 * (`TransportDeps.attach`) is a captured closure, so we invoke it directly
 * with synthetic events. Two load-bearing invariants:
 *
 *   1. Outbound REQUEST messages get a monotonic id and round-trip through
 *      the matching RESPONSE by id.
 *   2. The origin + source guard rejects anything from any source/origin
 *      other than the resolved parent (and refuses all inbound when origin
 *      is null — fail-closed).
 */

const PARENT_ORIGIN = 'https://merchant.flashmandu.example';

/** Build a fresh transport against a captured listener slot. */
function withHandlers(
    parentOrigin: string | null,
    handlers: { onContext: (p: never) => void; onResponse: (r: ProxyResponsePayload) => void },
) {
    const posts: Array<{ message: BridgeMessage; origin: string }> = [];
    const parentWindow = { postMessage(m: BridgeMessage, o: string) { posts.push({ message: m, origin: o }); } } as unknown as Window;
    let listener: ((event: MessageEvent) => void) | null = null;
    const transport = createTransport(handlers as never, parentOrigin, {
        parent: parentWindow,
        attach: (fn) => { listener = fn; return () => { listener = null; }; },
    });
    const emit = (source: Window, origin: string, data: unknown): void => {
        listener?.({ source, origin, data } as unknown as MessageEvent);
    };
    return { transport, parentWindow, posts, emit };
}

describe('transport id correlation', () => {
    it('allocates monotonic ids', () => {
        const { transport } = withHandlers(PARENT_ORIGIN, { onContext: () => {}, onResponse: () => {} });
        expect(transport.nextId()).toBe(1);
        expect(transport.nextId()).toBe(2);
        expect(transport.nextId()).toBe(3);
        transport.destroy();
    });

    it('sends REQUEST and correlates the matching RESPONSE by id', () => {
        const received: ProxyResponsePayload[] = [];
        const { transport, parentWindow, posts, emit } = withHandlers(PARENT_ORIGIN, {
            onContext: () => {},
            onResponse: (r) => { received.push(r); },
        });

        const id = transport.nextId();
        transport.send({ type: MessageType.Request, payload: { id, method: 'GET', path: 'me' } });

        expect(posts).toHaveLength(1);
        expect(posts[0]?.message.type).toBe(MessageType.Request);
        expect((posts[0]?.message.payload as { id: number }).id).toBe(id);

        // Parent posts the matching RESPONSE.
        emit(parentWindow, PARENT_ORIGIN, {
            type: MessageType.Response,
            payload: { id, status: 200, body: { ok: true } },
        });

        expect(received).toHaveLength(1);
        expect(received[0]?.id).toBe(id);
        expect(received[0]?.status).toBe(200);
        transport.destroy();
    });

    it('ignores a RESPONSE for an unrelated id (transport does not queue)', () => {
        const received: ProxyResponsePayload[] = [];
        const { transport, parentWindow, emit } = withHandlers(PARENT_ORIGIN, {
            onContext: () => {},
            onResponse: (r) => { received.push(r); },
        });

        emit(parentWindow, PARENT_ORIGIN, {
            type: MessageType.Response,
            payload: { id: 999, status: 200, body: null },
        });
        // The transport hands every valid RESPONSE to the handler; the higher
        // layer is the one that drops ids it has no waiter for. What matters
        // for this test: the message shape was parsed correctly.
        expect(received).toHaveLength(1);
        expect(received[0]?.id).toBe(999);
        transport.destroy();
    });
});

describe('transport origin + source guard', () => {
    it('rejects CONTEXT whose origin is not the resolved parent origin', () => {
        const onContext = vi.fn();
        const { transport, parentWindow, emit } = withHandlers(PARENT_ORIGIN, {
            onContext,
            onResponse: () => {},
        });

        emit(parentWindow, 'https://attacker.example', {
            type: MessageType.Context,
            payload: { origin: 'https://attacker.example' },
        });
        expect(onContext).not.toHaveBeenCalled();

        emit(parentWindow, PARENT_ORIGIN, {
            type: MessageType.Context,
            payload: { origin: PARENT_ORIGIN },
        });
        expect(onContext).toHaveBeenCalledTimes(1);
        transport.destroy();
    });

    it('rejects messages whose source is not the parent window', () => {
        const onContext = vi.fn();
        const { transport, emit } = withHandlers(PARENT_ORIGIN, {
            onContext,
            onResponse: () => {},
        });

        emit({} as Window, PARENT_ORIGIN, {
            type: MessageType.Context,
            payload: { origin: PARENT_ORIGIN },
        });
        expect(onContext).not.toHaveBeenCalled();
        transport.destroy();
    });

    it('refuses all inbound when origin is null (fail-closed)', () => {
        const onContext = vi.fn();
        const { transport, parentWindow, emit } = withHandlers(null, {
            onContext,
            onResponse: () => {},
        });

        emit(parentWindow, PARENT_ORIGIN, {
            type: MessageType.Context,
            payload: { origin: PARENT_ORIGIN },
        });
        expect(onContext).not.toHaveBeenCalled();
        transport.destroy();
    });

    it('does not send outbound when origin is null', () => {
        const { transport, posts } = withHandlers(null, {
            onContext: () => {},
            onResponse: () => {},
        });
        transport.send({ type: MessageType.Toast, payload: { message: 'x' } });
        expect(posts).toHaveLength(0);
        transport.destroy();
    });

    it('only fires CONTEXT once (first-wins)', () => {
        const onContext = vi.fn();
        const { transport, parentWindow, emit } = withHandlers(PARENT_ORIGIN, {
            onContext,
            onResponse: () => {},
        });

        emit(parentWindow, PARENT_ORIGIN, { type: MessageType.Context, payload: { origin: PARENT_ORIGIN } });
        emit(parentWindow, PARENT_ORIGIN, { type: MessageType.Context, payload: { origin: PARENT_ORIGIN } });
        expect(onContext).toHaveBeenCalledTimes(1);
        transport.destroy();
    });

    it('detach is idempotent', () => {
        const { transport } = withHandlers(PARENT_ORIGIN, { onContext: () => {}, onResponse: () => {} });
        expect(() => { transport.destroy(); transport.destroy(); }).not.toThrow();
    });
});

describe('query-param + origin resolution helpers', () => {
    it('prefers the signed parent_origin query param', () => {
        expect(resolveParentOrigin('?parent_origin=https://a.example&app_id=x'))
            .toBe('https://a.example');
    });

    it('reads query params safely', () => {
        expect(readQueryParam('', 'parent_origin')).toBeNull();
        expect(readQueryParam('?parent_origin=', 'parent_origin')).toBeNull();
        expect(readQueryParam('?app_id=app_1', 'app_id')).toBe('app_1');
    });
});

describe('allowedParentOrigins is an allowlist, not a fallback (SEC-1)', () => {
    const ALLOW = ['https://shop.flashmandu.test'] as const;

    it('rejects a parent_origin query param outside the allowlist', () => {
        // The attack: frame the app with ?parent_origin=<attacker> and become
        // the trusted parent. The allowlist must veto it.
        expect(
            resolveParentOrigin('?parent_origin=https://evil.test', ALLOW),
        ).toBeNull();
    });

    it('honours a parent_origin query param inside the allowlist', () => {
        expect(
            resolveParentOrigin('?parent_origin=https://shop.flashmandu.test', ALLOW),
        ).toBe('https://shop.flashmandu.test');
    });

    it('normalises the query param before matching', () => {
        // A trailing slash or a full URL must not defeat the membership check.
        expect(
            resolveParentOrigin('?parent_origin=https://shop.flashmandu.test/', ALLOW),
        ).toBe('https://shop.flashmandu.test');
    });

    it('falls back to a single declared origin when nothing is discoverable', () => {
        expect(resolveParentOrigin('', ALLOW)).toBe('https://shop.flashmandu.test');
    });

    it('refuses to guess when the allowlist is ambiguous and nothing is discoverable', () => {
        expect(
            resolveParentOrigin('', ['https://a.test', 'https://b.test']),
        ).toBeNull();
    });

    it('still resolves the discovered origin when no allowlist is configured', () => {
        expect(resolveParentOrigin('?parent_origin=https://a.example'))
            .toBe('https://a.example');
    });

    it('a rejected origin means the transport dispatches nothing', () => {
        // Fail-closed end-to-end: null origin => no inbound, no outbound.
        const origin = resolveParentOrigin('?parent_origin=https://evil.test', ALLOW);
        expect(origin).toBeNull();

        const onContext = vi.fn();
        let listener: ((event: MessageEvent) => void) | undefined;
        const parent = { postMessage: vi.fn() } as unknown as Window;

        const transport = createTransport(
            { onContext, onResponse: vi.fn() },
            origin,
            {
                parent,
                attach: (l) => {
                    listener = l;
                    return () => {};
                },
            },
        );

        listener?.({
            source: parent,
            origin: 'https://evil.test',
            data: { type: 'FLASHMANDU_BRIDGE:CONTEXT', payload: { origin: 'https://evil.test' } },
        } as unknown as MessageEvent);

        expect(onContext).not.toHaveBeenCalled();

        transport.send({ type: 'FLASHMANDU_BRIDGE:READY' } as never);
        expect(parent.postMessage).not.toHaveBeenCalled();

        transport.destroy();
    });
});
