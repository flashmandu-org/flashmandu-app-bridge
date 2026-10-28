import { afterEach, describe, expect, it, vi } from 'vitest';

import { createMockHost, type MockHost } from '../testing/index.js';
import {
    createDirectFetch,
    DIRECT_TOKEN_HEADER,
    DIRECT_TOKEN_REJECTED_HEADER,
    directTokenHeaders,
} from '../direct-fetch.js';

/**
 * directFetch (0.6.6): the browser carries the host-minted DIRECT token to the
 * app's OWN server in `X-Flashmandu-Direct-Token`, so the server can act for
 * the store the merchant is in (the pod's FLASHMANDU_API_TOKEN is one install).
 */

let host: MockHost;
const never = (): (() => void) => () => {};

afterEach(() => {
    host?.restore();
});

function headerOf(init: RequestInit | undefined): string | null {
    return new Headers(init?.headers).get(DIRECT_TOKEN_HEADER);
}

describe('directFetch', () => {
    it('attaches a HOST-minted token, never the embed-URL session token', async () => {
        host = createMockHost({ token: 'tok_boot' });
        const bridge = host.createBridge({ schedule: never });
        await bridge.ready();
        const fetchImpl = vi.fn(async () => new Response('{}', { status: 200 }));

        const res = await createDirectFetch(bridge, fetchImpl)('/api/x', { method: 'POST', headers: { 'content-type': 'application/json' } });

        expect(res.status).toBe(200);
        const init = fetchImpl.mock.calls[0]?.[1] as RequestInit;
        expect(headerOf(init)).toBe('tok_refreshed_1');
        expect(new Headers(init.headers).get('content-type')).toBe('application/json');
        expect(host.tokenRefreshCount()).toBe(1);
    });

    it('reuses the cached direct token across calls (one TOKEN_REFRESH)', async () => {
        host = createMockHost({ token: 'tok_boot' });
        const bridge = host.createBridge({ schedule: never });
        await bridge.ready();
        const fetchImpl = vi.fn(async () => new Response('{}', { status: 200 }));
        const df = createDirectFetch(bridge, fetchImpl);

        await Promise.all([df('/a'), df('/b')]);
        await df('/c');

        expect(host.tokenRefreshCount()).toBe(1);
        expect(fetchImpl.mock.calls.map((c) => headerOf(c[1] as RequestInit))).toEqual([
            'tok_refreshed_1',
            'tok_refreshed_1',
            'tok_refreshed_1',
        ]);
    });

    it('re-mints once and retries when the app server says the token was rejected', async () => {
        host = createMockHost({ token: 'tok_boot' });
        const bridge = host.createBridge({ schedule: never });
        await bridge.ready();
        const fetchImpl = vi
            .fn()
            .mockResolvedValueOnce(new Response('{}', { status: 401, headers: { [DIRECT_TOKEN_REJECTED_HEADER]: '1' } }))
            .mockResolvedValueOnce(new Response('{}', { status: 200 }));

        const res = await createDirectFetch(bridge, fetchImpl)('/api/x', { method: 'DELETE' });

        expect(res.status).toBe(200);
        expect(fetchImpl).toHaveBeenCalledTimes(2);
        expect(headerOf(fetchImpl.mock.calls[1]?.[1] as RequestInit)).toBe('tok_refreshed_2');
        expect(host.tokenRefreshCount()).toBe(2);
    });

    it('does not retry a plain 401 (no rejected marker) or a second rejection', async () => {
        host = createMockHost({ token: 'tok_boot' });
        const bridge = host.createBridge({ schedule: never });
        await bridge.ready();
        const plain = vi.fn(async () => new Response('{}', { status: 401 }));
        expect((await createDirectFetch(bridge, plain)('/a')).status).toBe(401);
        expect(plain).toHaveBeenCalledTimes(1);

        const rejected = vi.fn(async () => new Response('{}', { status: 401, headers: { [DIRECT_TOKEN_REJECTED_HEADER]: '1' } }));
        expect((await createDirectFetch(bridge, rejected)('/a')).status).toBe(401);
        expect(rejected).toHaveBeenCalledTimes(2);
    });

    it('still sends (without the header) when the host cannot mint, so the server answers in its own words', async () => {
        host = createMockHost({ token: 'tok_boot' });
        const bridge = host.createBridge({ schedule: (fn) => { fn(); return () => {}; } });
        await bridge.ready();
        host.autoToken(false);
        const fetchImpl = vi.fn(async () => new Response('{}', { status: 502 }));

        const res = await createDirectFetch(bridge, fetchImpl)('/a');

        expect(res.status).toBe(502);
        expect(headerOf(fetchImpl.mock.calls[0]?.[1] as RequestInit)).toBeNull();
    });

    it('directTokenHeaders gives the same header for an XHR (upload progress)', async () => {
        host = createMockHost({ token: 'tok_boot' });
        const bridge = host.createBridge({ schedule: never });
        await bridge.ready();
        await expect(directTokenHeaders(bridge)).resolves.toEqual({ [DIRECT_TOKEN_HEADER]: 'tok_refreshed_1' });
    });
});
