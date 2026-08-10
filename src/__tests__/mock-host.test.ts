import { afterEach, describe, expect, it } from 'vitest';

import { createMockHost, type MockHost } from '../testing/index.js';
import { MessageType } from '../types.js';

/**
 * The mock host is a shipped deliverable, not test scaffolding, so it gets its
 * own tests. If it drifts from the real protocol it becomes worse than nothing:
 * every app's suite would go green against a host that does not exist.
 */

let host: MockHost;

afterEach(() => {
    host?.restore();
});

describe('boot', () => {
    it('answers READY with CONTEXT so `ready()` settles without a tick', async () => {
        host = createMockHost();
        const bridge = host.createBridge();

        expect(host.sent[0]?.type).toBe(MessageType.Ready);
        await expect(bridge.ready()).resolves.toMatchObject({ origin: host.origin });
    });

    it('can withhold CONTEXT to exercise the pre-ready state', () => {
        host = createMockHost({ autoContext: false });
        const bridge = host.createBridge();

        expect(bridge.context).toBeNull();
        host.sendContext();
        expect(bridge.context?.origin).toBe(host.origin);
    });

    it('stamps a usable embed URL', () => {
        host = createMockHost({ appId: 'app_map', profileId: 7, token: 'tok_x' });
        const bridge = host.createBridge();

        expect(bridge.context).toMatchObject({ appId: 'app_map', profileId: 7, token: 'tok_x' });
    });

    it('restores the previous global window', () => {
        const before = (globalThis as Record<string, unknown>).window;
        host = createMockHost();
        host.createBridge();
        expect((globalThis as Record<string, unknown>).window).not.toBe(before);
        host.restore();
        expect((globalThis as Record<string, unknown>).window).toBe(before);
    });
});

describe('recording', () => {
    it('records every outbound message with its target origin', () => {
        host = createMockHost();
        const bridge = host.createBridge();
        host.reset();

        bridge.navigate('/somewhere');
        bridge.setSidebarLinks([{ label: 'Maps', path: '/maps' }]);
        bridge.loading(true);

        expect(host.navigations()).toEqual(['/somewhere']);
        expect(host.sidebarLinks()).toEqual([{ label: 'Maps', path: '/maps' }]);
        expect(host.loadingStates()).toEqual([true]);
        expect(host.sent.every((m) => m.targetOrigin === host.origin)).toBe(true);
    });

    it('exposes arbitrary message types through messagesOf', () => {
        host = createMockHost();
        const bridge = host.createBridge();
        bridge.channel.post('CUSTOM', { a: 1 });
        expect(host.messagesOf('CUSTOM')).toEqual([{ a: 1 }]);
    });

    it('reset() clears recordings but keeps the bridge alive', () => {
        host = createMockHost();
        const bridge = host.createBridge();
        host.reset();
        expect(host.sent).toEqual([]);
        bridge.loading(true);
        expect(host.loadingStates()).toEqual([true]);
    });
});

describe('scripting the host side', () => {
    it('scripts a sidebar click and records the ack', async () => {
        host = createMockHost();
        const bridge = host.createBridge();
        const seen: string[] = [];
        bridge.onHostNavigate((path) => seen.push(path));

        const id = host.hostNavigate('/maps/9');

        expect(seen).toEqual(['/maps/9']);
        expect(host.acks()).toEqual([{ id, path: '/maps/9' }]);
    });

    it('records no ack when the app has no host-navigate listener', () => {
        host = createMockHost();
        host.createBridge();
        host.hostNavigate('/maps/9');
        expect(host.acks()).toEqual([]);
    });

    it('scripts API responses per path and per attempt', async () => {
        host = createMockHost();
        const bridge = host.createBridge({ schedule: (fn) => { fn(); return () => {}; } });
        await bridge.ready();

        host.stub('GET', 'me', { status: 200, body: { id: 1 } });
        host.stubSequence('GET', 'orders', [{ status: 429 }, { status: 200, body: [] }]);

        await expect(bridge.request({ method: 'GET', path: 'me' })).resolves.toMatchObject({
            status: 200, body: { id: 1 },
        });
        await expect(bridge.request({ method: 'GET', path: 'orders' })).resolves.toMatchObject({
            status: 200, attempts: 2,
        });
    });

    it('treats a leading slash on a path as the same route', async () => {
        host = createMockHost();
        const bridge = host.createBridge();
        await bridge.ready();
        host.stub('GET', 'me', { status: 204 });

        await expect(bridge.request({ method: 'GET', path: '/me' })).resolves.toMatchObject({ status: 204 });
    });

    it('falls back to a default response for an unstubbed path', async () => {
        host = createMockHost({ defaultResponse: { status: 404, body: { error: 'nope' } } });
        const bridge = host.createBridge();
        await bridge.ready();

        await expect(bridge.request({ method: 'GET', path: 'unknown' })).resolves.toMatchObject({
            status: 404,
        });
    });

    it('stubs the two transports separately, because they speak different protocols', async () => {
        host = createMockHost({ capabilities: { directApi: true } });
        const bridge = host.createBridge();
        await bridge.ready();

        host.stub('GET', 'me', { status: 200, body: { id: 1 } });
        host.onGraphql(() => ({ status: 200, body: { data: { me: { id: 1 } } } }));

        const proxied = await bridge.request({ method: 'GET', path: 'me' });
        const direct = await bridge.graphql('{ me { id } }');

        expect(proxied.transport).toBe('proxy');
        expect(direct.transport).toBe('direct');
    });

    it('400s a proxy envelope posted to the GraphQL endpoint', async () => {
        // Guards the exact regression this split exists to prevent. The direct
        // endpoint is Lighthouse's GraphQLController mounted directly — not a
        // twin of the REST proxy — so a `{method, path, body}` envelope is a
        // query-less request and must fail, loudly, in tests.
        host = createMockHost({ capabilities: { directApi: true } });
        host.createBridge();

        const response = await host.fetchImpl(`${host.origin}/api/apps/graphql`, {
            method: 'POST',
            body: JSON.stringify({ method: 'GET', path: 'me', body: null }),
        });

        expect(response.status).toBe(400);
        expect(host.graphqlCalls()).toHaveLength(0);
    });
});
