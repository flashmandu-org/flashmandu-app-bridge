import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createAppBridge } from '../app-bridge.js';
import { MessageType } from '../types.js';

/**
 * HOST_NAVIGATE is the one inbound message the bridge handles off the raw
 * `window` rather than through the transport: the host posts it so a framed
 * app can route internally instead of the whole admin page reloading. It is
 * held to the transport's gate all the same — parent origin, parent source,
 * fail-closed when the origin is unknown — because an unguarded listener here
 * would be the weakest door in the wall.
 *
 * There is no jsdom in this repo (and no new dependency to add one), so the
 * suite installs a minimal `EventTarget`-backed `window` for the duration of
 * each test. That is enough: the bridge only needs `addEventListener`,
 * `removeEventListener`, and `dispatchEvent`.
 *
 * Events are hand-built rather than constructed with `new MessageEvent(...)`:
 * Node's MessageEvent rejects an `init.source` that is not a MessagePort, and
 * the source check is exactly what these tests need to exercise.
 */

const PARENT_ORIGIN = 'https://merchant.flashmandu.example';
const SEARCH = `?session_token=t&app_id=a&parent_origin=${encodeURIComponent(PARENT_ORIGIN)}`;

interface SentMessage {
    data: { type?: string; payload?: unknown };
    targetOrigin: string;
}

interface FakeWindow extends EventTarget {
    parent: FakeWindow;
    postMessage: (message: unknown, targetOrigin: string) => void;
    sent: SentMessage[];
}

function installFakeWindow(): FakeWindow {
    const fake = new EventTarget() as FakeWindow;
    fake.parent = fake;
    fake.sent = [];
    fake.postMessage = (message: unknown, targetOrigin: string): void => {
        fake.sent.push({ data: message as SentMessage['data'], targetOrigin });
    };
    (globalThis as Record<string, unknown>).window = fake;
    return fake;
}

/** Every HOST_NAVIGATE_ACK the bridge has posted to the parent so far. */
function acks(): SentMessage[] {
    return host.sent.filter((m) => m.data.type === MessageType.HostNavigateAck);
}

let host: FakeWindow;

beforeEach(() => {
    host = installFakeWindow();
});

afterEach(() => {
    delete (globalThis as Record<string, unknown>).window;
});

function makeBridge(search: string = SEARCH): ReturnType<typeof createAppBridge> {
    return createAppBridge({ search, parent: host.parent as unknown as Window });
}

/** Dispatch a synthetic `message` event with a settable `source`. */
function dispatchMessage(init: { data: unknown; origin?: string; source?: unknown }): void {
    const event = new Event('message') as Event & Record<string, unknown>;
    event.data = init.data;
    event.origin = init.origin ?? PARENT_ORIGIN;
    event.source = 'source' in init ? init.source : host;
    host.dispatchEvent(event);
}

/** Post a raw HOST_NAVIGATE payload, exactly as given. */
function postHostNavigate(payload: unknown): void {
    dispatchMessage({ data: { type: MessageType.HostNavigate, payload } });
}

/** Post a well-formed HOST_NAVIGATE. The host always allocates the id. */
function postNavigate(path: string, id = 1): void {
    postHostNavigate({ id, path });
}

describe('onHostNavigate', () => {
    it('invokes the listener when the host asks the app to route', () => {
        const bridge = makeBridge();
        const seen: string[] = [];
        bridge.onHostNavigate((path) => seen.push(path));

        postNavigate('/members');

        expect(seen).toEqual(['/members']);
    });

    it('stops calling the listener after unsubscribe', () => {
        const bridge = makeBridge();
        const listener = vi.fn();
        const off = bridge.onHostNavigate(listener);
        off();

        postNavigate('/settings');

        expect(listener).not.toHaveBeenCalled();
    });

    it('stops calling the listener after the bridge is destroyed', () => {
        const bridge = makeBridge();
        const listener = vi.fn();
        bridge.onHostNavigate(listener);
        bridge.destroy();

        postNavigate('/settings');

        expect(listener).not.toHaveBeenCalled();
    });

    it('ignores a HOST_NAVIGATE from any origin other than the parent', () => {
        const bridge = makeBridge();
        const listener = vi.fn();
        bridge.onHostNavigate(listener);

        dispatchMessage({
            data: { type: MessageType.HostNavigate, payload: { id: 1, path: '/members' } },
            origin: 'https://evil.example',
        });

        expect(listener).not.toHaveBeenCalled();
    });

    it('ignores a HOST_NAVIGATE from a window that is not the parent', () => {
        const bridge = makeBridge();
        const listener = vi.fn();
        bridge.onHostNavigate(listener);

        dispatchMessage({
            data: { type: MessageType.HostNavigate, payload: { id: 1, path: '/members' } },
            source: new EventTarget(),
        });

        expect(listener).not.toHaveBeenCalled();
    });

    it('accepts nothing at all when no parent origin could be resolved', () => {
        // Fail-closed, same as the transport: with no `parent_origin` param and
        // no referrer there is no origin to compare against, so every inbound
        // HOST_NAVIGATE is dropped rather than trusted.
        const bridge = makeBridge('?session_token=t&app_id=a');
        const listener = vi.fn();
        bridge.onHostNavigate(listener);

        postNavigate('/members');

        expect(listener).not.toHaveBeenCalled();
    });

    it('rejects payloads that are not an app-relative path', () => {
        const bridge = makeBridge();
        const listener = vi.fn();
        bridge.onHostNavigate(listener);

        // Absolute URLs, protocol-relative URLs, scheme payloads, and
        // non-strings are all untrusted input arriving over postMessage.
        postHostNavigate({ id: 1, path: 'https://evil.example/members' });
        postHostNavigate({ id: 1, path: '//evil.example/members' });
        postHostNavigate({ id: 1, path: '/\\evil.example/members' });
        postHostNavigate({ id: 1, path: 'javascript:alert(1)' });
        postHostNavigate({ id: 1, path: 42 });
        postHostNavigate({ id: 1 });
        postHostNavigate(undefined);

        expect(listener).not.toHaveBeenCalled();
    });

    it('drops a HOST_NAVIGATE with a missing or non-numeric id', () => {
        // The host is the only sender and always numbers its navigations, so a
        // message without a usable id is malformed. Dropping it is the same
        // fail-closed call as a bad origin — an ack the host cannot match is
        // worse than the silence it already handles.
        const bridge = makeBridge();
        const listener = vi.fn();
        bridge.onHostNavigate(listener);

        postHostNavigate({ path: '/members' });
        postHostNavigate({ id: null, path: '/members' });
        postHostNavigate({ id: '1', path: '/members' });
        postHostNavigate({ id: Number.NaN, path: '/members' });
        postHostNavigate({ id: Number.POSITIVE_INFINITY, path: '/members' });

        expect(listener).not.toHaveBeenCalled();
    });

    it('ignores messages of any other type', () => {
        const bridge = makeBridge();
        const listener = vi.fn();
        bridge.onHostNavigate(listener);

        dispatchMessage({
            data: { type: MessageType.Context, payload: { id: 1, path: '/members' } },
        });

        expect(listener).not.toHaveBeenCalled();
    });
});

/**
 * The ack is the host's only evidence that a navigate landed. The host
 * suppresses the merchant's click, rewrites the address bar with pushState and
 * moves the active highlight BEFORE posting, so a dropped message leaves the
 * chrome lying about what the iframe is showing — and the pushState means
 * re-clicking the same link is a no-op. Silence therefore has to mean "did not
 * route", which makes the negative cases below as load-bearing as the positive
 * one.
 *
 * Correlation is by `id`, not by path: two rapid clicks on the same link are
 * otherwise indistinguishable, and a late ack for the first would satisfy the
 * second.
 */
describe('HOST_NAVIGATE_ACK', () => {
    it('acks a navigate that reached a registered listener', () => {
        const bridge = makeBridge();
        bridge.onHostNavigate(() => {});

        postNavigate('/members', 7);

        expect(acks()).toEqual([{
            data: {
                type: MessageType.HostNavigateAck,
                payload: { id: 7, path: '/members' },
            },
            targetOrigin: PARENT_ORIGIN,
        }]);
    });

    it('echoes the host id verbatim rather than a counter of its own', () => {
        // The id belongs to the host. Two navigations to the SAME path must be
        // told apart by their ids alone — this is the whole point of the pair.
        const bridge = makeBridge();
        bridge.onHostNavigate(() => {});

        postNavigate('/members', 41);
        postNavigate('/members', 42);

        expect(acks().map((m) => m.data.payload)).toEqual([
            { id: 41, path: '/members' },
            { id: 42, path: '/members' },
        ]);
    });

    it('does not ack when the origin gate rejects the message', () => {
        const bridge = makeBridge();
        bridge.onHostNavigate(() => {});

        dispatchMessage({
            data: { type: MessageType.HostNavigate, payload: { id: 1, path: '/members' } },
            origin: 'https://evil.example',
        });

        expect(acks()).toEqual([]);
    });

    it('does not ack when no listener is registered', () => {
        // An app that imported the SDK but never subscribed is exactly the case
        // the host needs to detect, so a well-formed navigate still gets silence.
        makeBridge();

        postNavigate('/members');

        expect(acks()).toEqual([]);
    });

    it('does not ack a payload the path guard rejects', () => {
        const bridge = makeBridge();
        bridge.onHostNavigate(() => {});

        postNavigate('//evil.example/members');

        expect(acks()).toEqual([]);
    });

    it('does not ack a message with a missing or non-numeric id', () => {
        const bridge = makeBridge();
        bridge.onHostNavigate(() => {});

        postHostNavigate({ path: '/members' });
        postHostNavigate({ id: '1', path: '/members' });
        postHostNavigate({ id: Number.NaN, path: '/members' });

        expect(acks()).toEqual([]);
    });

    it('acks once per accepted navigate, whatever the listener count', () => {
        const bridge = makeBridge();
        bridge.onHostNavigate(() => {});
        bridge.onHostNavigate(() => {});

        postNavigate('/members');

        expect(acks()).toHaveLength(1);
    });

    it('still acks when a listener throws', () => {
        // The listener received the path; that it then failed is the app's
        // problem, not a transport failure the host should try to recover from.
        const bridge = makeBridge();
        bridge.onHostNavigate(() => {
            throw new Error('router blew up');
        });

        postNavigate('/members', 9);

        expect(acks()).toEqual([{
            data: {
                type: MessageType.HostNavigateAck,
                payload: { id: 9, path: '/members' },
            },
            targetOrigin: PARENT_ORIGIN,
        }]);
    });

    it('does not consume the REQUEST id sequence', () => {
        // The host numbers HOST_NAVIGATE from its own counter. If the SDK ever
        // reached for `transport.nextId()` here, the next proxied request would
        // skip an id and the REQUEST/RESPONSE correlation would drift.
        const bridge = makeBridge();
        bridge.onHostNavigate(() => {});

        postNavigate('/members', 999);
        void bridge.request({ method: 'GET', path: 'me' });

        const requests = host.sent.filter((m) => m.data.type === MessageType.Request);
        expect(requests).toHaveLength(1);
        expect((requests[0]?.data.payload as { id: number }).id).toBe(1);
    });
});
