import { afterEach, describe, expect, it, vi } from 'vitest';

import { createMockHost, type MockHost } from '../testing/index.js';

/**
 * `request()` across both transports (design §4.7 direct, §4.8 hardening).
 *
 * The two paths must be indistinguishable from the caller's seat — same
 * result shape, same retry behaviour, same rate info — because the choice
 * between them is made by the HOST's capability announcement, not by the app.
 * Anything that differs is a bug an app author would have to code around, which
 * would defeat the point of the optimisation.
 */

let host: MockHost;

/** Runs backoff sleeps immediately, so retry tests need no wall-clock waiting. */
const immediate = (fn: () => void): (() => void) => {
    fn();
    return () => {};
};

afterEach(() => {
    host?.restore();
});

async function mount(capabilities: Record<string, boolean> = {}) {
    host = createMockHost({ capabilities });
    const bridge = host.createBridge({ schedule: immediate, random: () => 0 });
    await bridge.ready();
    return bridge;
}

describe('request() is the REST proxy, always', () => {
    it('goes over postMessage even when the host announces directApi', async () => {
        const bridge = await mount({ directApi: true });
        host.stub('GET', 'me', { status: 200, body: { id: 1 } });

        const result = await bridge.request({ method: 'GET', path: 'me' });

        // `request()` speaks the proxy's REST allow-list; the direct endpoint is
        // a GraphQL server and cannot serve it. Routing it there would put a
        // `{method, path, body}` envelope on the wire that GraphQL rejects.
        expect(result.transport).toBe('proxy');
        expect(result.body).toEqual({ id: 1 });
        expect(host.messagesOf('FLASHMANDU_BRIDGE:REQUEST')).toHaveLength(1);
        expect(host.graphqlCalls()).toHaveLength(0);
    });

    it('reports limit and reset as null — the proxy does not forward them', async () => {
        const bridge = await mount();
        host.stub('GET', 'me', { status: 200, body: {}, remaining: 5 });

        const result = await bridge.request({ method: 'GET', path: 'me' });

        expect(result.remaining).toBe(5);
        expect(result.limit).toBeNull();
        expect(result.reset).toBeNull();
    });
});

describe('graphql() — the direct transport', () => {
    it('posts a REAL GraphQL body, not a proxy envelope', async () => {
        const bridge = await mount({ directApi: true });
        host.onGraphql(() => ({ status: 200, body: { data: { me: { id: 1 } } } }));

        const result = await bridge.graphql('query Me { me { id } }', { first: 10 });

        const call = host.graphqlCalls()[0];
        expect(call?.query).toBe('query Me { me { id } }');
        expect(call?.variables).toEqual({ first: 10 });
        expect(call?.url).toBe(`${host.origin}/api/apps/graphql`);
        expect(result.transport).toBe('direct');
        // The whole GraphQL envelope, never just `data`: a partial success
        // carries both halves and unwrapping would throw one away.
        expect(result.body).toEqual({ data: { me: { id: 1 } } });
        expect(host.messagesOf('FLASHMANDU_BRIDGE:REQUEST')).toHaveLength(0);
    });

    it('forwards operationName when the document declares several', async () => {
        const bridge = await mount({ directApi: true });
        await bridge.graphql('query A { a } query B { b }', undefined, { operationName: 'B' });
        expect(host.graphqlCalls()[0]?.operationName).toBe('B');
    });

    it('omits variables entirely when none were given', async () => {
        const bridge = await mount({ directApi: true });
        await bridge.graphql('{ me { id } }');
        expect(host.graphqlCalls()[0]?.variables).toBeNull();
    });

    it('presents the short-TTL session token as a bearer', async () => {
        const bridge = await mount({ directApi: true });
        await bridge.graphql('{ me { id } }');
        expect(host.graphqlCalls()[0]?.token).toBe('tok_initial');
    });

    it('refreshes an about-to-expire token before calling', async () => {
        const now = 1_000_000;
        host = createMockHost({ capabilities: { directApi: true }, expiresAt: now + 1_000 });
        const bridge = host.createBridge({ schedule: immediate, now: () => now });
        await bridge.ready();

        await bridge.graphql('{ me { id } }');

        expect(host.tokenRefreshCount()).toBe(1);
        expect(host.graphqlCalls()[0]?.token).toBe('tok_refreshed_1');
    });

    it('rejects when the host never announced directApi', async () => {
        const bridge = await mount({ directApi: false });
        await expect(bridge.graphql('{ me { id } }')).rejects.toThrow(/did not announce/);
        expect(host.graphqlCalls()).toHaveLength(0);
    });

    it('rejects when direct access is disabled locally', async () => {
        host = createMockHost({ capabilities: { directApi: true } });
        const bridge = host.createBridge({ schedule: immediate, disableDirectApi: true });
        await bridge.ready();
        await expect(bridge.graphql('{ me { id } }')).rejects.toThrow(/disabled/);
    });

    it('rejects an empty document without touching the network', async () => {
        const bridge = await mount({ directApi: true });
        await expect(bridge.graphql('')).rejects.toThrow(/non-empty/);
        await expect(bridge.graphql('   ')).rejects.toThrow(/non-empty/);
        expect(host.graphqlCalls()).toHaveLength(0);
    });

    it('rejects after destroy', async () => {
        const bridge = await mount({ directApi: true });
        bridge.destroy();
        await expect(bridge.graphql('{ me { id } }')).rejects.toThrow(/destroyed/);
    });

    it('surfaces status 0 on a network failure, like the proxy does', async () => {
        host = createMockHost({ capabilities: { directApi: true } });
        const bridge = host.createBridge({
            schedule: immediate,
            fetchImpl: (() => Promise.reject(new Error('offline'))) as unknown as typeof fetch,
        });
        await bridge.ready();

        const result = await bridge.graphql('{ me { id } }');
        expect(result.status).toBe(0);
        expect(result.body).toBeNull();
    });

    it.each([
        [403, { error: 'origin_not_allowed' }],
        [401, { error: 'invalid_token' }],
        [401, { error: 'origin_mismatch' }],
    ])('returns terminal middleware failure %i %o without retrying', async (status, body) => {
        // These are middleware JSON, NOT GraphQL envelopes — which is exactly
        // why callers must branch on `status` before they reach for `.errors`.
        const bridge = await mount({ directApi: true });
        host.onGraphql(() => ({ status, body }));

        const result = await bridge.graphql('{ me { id } }');

        expect(result.status).toBe(status);
        expect(result.body).toEqual(body);
        expect(result.attempts).toBe(1);
        expect(host.graphqlCalls()).toHaveLength(1);
    });

    it('passes a 200 field-level error envelope through untouched', async () => {
        const bridge = await mount({ directApi: true });
        const envelope = {
            data: { me: null },
            errors: [{ message: 'Cannot read catalog.', extensions: { code: 'SCOPE_DENIED', scope: 'read:catalog' } }],
        };
        host.onGraphql(() => ({ status: 200, body: envelope }));

        const result = await bridge.graphql('{ me { id } catalog { id } }');

        // A scope denial is an HTTP 200 with a GraphQL envelope, same as the
        // existing bearer path. Treating it as a transport failure — or
        // unwrapping to `data` and dropping `errors` — would hide it entirely.
        expect(result.status).toBe(200);
        expect(result.body).toEqual(envelope);
        expect(result.attempts).toBe(1);
    });

    it('does not retry a 200 carrying errors', async () => {
        const bridge = await mount({ directApi: true });
        host.onGraphql(() => ({ status: 200, body: { errors: [{ message: 'nope' }] } }));
        const result = await bridge.graphql('{ me { id } }');
        expect(result.attempts).toBe(1);
    });

    it('names the proxy in its error when the host could not resolve an app id', async () => {
        // `capabilities.directApi` is false in that case, and an app author
        // needs to be told where to go instead of guessing at a CORS failure.
        const bridge = await mount({ directApi: false });
        await expect(bridge.graphql('{ me { id } }')).rejects.toThrow(/bridge\.request\(\)/);
    });
});

describe('graphql() retry is decided by the OPERATION, not the HTTP method', () => {
    it('retries a read-only document on 429', async () => {
        const bridge = await mount({ directApi: true });
        host.stubGraphqlSequence([
            { status: 429, retryAfter: 1 },
            { status: 200, body: { data: { me: {} } } },
        ]);

        const result = await bridge.graphql('query Me { me { id } }');

        expect(result.status).toBe(200);
        expect(result.attempts).toBe(2);
    });

    it('NEVER retries a document containing a mutation', async () => {
        const bridge = await mount({ directApi: true });
        host.onGraphql(() => ({ status: 429, retryAfter: 1 }));

        const result = await bridge.graphql('mutation Save($x: ID!) { save(id: $x) { id } }');

        expect(result.attempts).toBe(1);
        expect(host.graphqlCalls()).toHaveLength(1);
    });

    it('NEVER retries a multi-operation document that contains a mutation', async () => {
        // The mutation text ships even when operationName names the query, so
        // guessing from the named operation alone would replay a write.
        const bridge = await mount({ directApi: true });
        host.onGraphql(() => ({ status: 503 }));

        const result = await bridge.graphql(
            'query A { a } mutation B { b }', undefined, { operationName: 'A' },
        );

        expect(result.attempts).toBe(1);
    });

    it('does not retry a subscription document', async () => {
        const bridge = await mount({ directApi: true });
        host.onGraphql(() => ({ status: 503 }));
        const result = await bridge.graphql('subscription S { s }');
        expect(result.attempts).toBe(1);
    });

    it('lets a caller force a retry for a mutation carrying an idempotency key', async () => {
        const bridge = await mount({ directApi: true });
        host.stubGraphqlSequence([
            { status: 503 },
            { status: 200, body: { data: { save: { id: 1 } } } },
        ]);

        const result = await bridge.graphql(
            'mutation Save { save { id } }', undefined, { retry: true },
        );

        expect(result.attempts).toBe(2);
    });

    it('lets a caller opt a read out', async () => {
        const bridge = await mount({ directApi: true });
        host.onGraphql(() => ({ status: 429 }));
        const result = await bridge.graphql('{ me { id } }', undefined, { retry: false });
        expect(result.attempts).toBe(1);
    });

    it('gives up after three attempts', async () => {
        const bridge = await mount({ directApi: true });
        host.onGraphql(() => ({ status: 429, retryAfter: 1 }));
        const result = await bridge.graphql('{ me { id } }');
        expect(result.attempts).toBe(3);
    });
});

describe('retry and backoff', () => {
    it('retries an idempotent GET on 429 up to three attempts', async () => {
        const bridge = await mount();
        host.stubSequence('GET', 'orders', [
            { status: 429, retryAfter: 1 },
            { status: 429, retryAfter: 1 },
            { status: 200, body: { ok: true } },
        ]);

        const result = await bridge.request({ method: 'GET', path: 'orders' });

        expect(result.status).toBe(200);
        expect(result.attempts).toBe(3);
    });

    it('gives up after the third attempt and returns the last response', async () => {
        const bridge = await mount();
        host.stub('GET', 'orders', { status: 503, retryAfter: 2 });

        const result = await bridge.request({ method: 'GET', path: 'orders' });

        expect(result.status).toBe(503);
        expect(result.attempts).toBe(3);
        expect(result.retryAfter).toBe(2);
    });

    it('NEVER auto-retries a POST — a duplicated write is worse than an error', async () => {
        const bridge = await mount();
        const calls = vi.fn(() => ({ status: 429, retryAfter: 1 }));
        host.onApiCall(calls);

        const result = await bridge.request({ method: 'POST', path: 'orders', body: { qty: 1 } });

        expect(result.status).toBe(429);
        expect(result.attempts).toBe(1);
        expect(calls).toHaveBeenCalledTimes(1);
    });

    it('lets a caller opt a POST in when it carries its own idempotency key', async () => {
        const bridge = await mount();
        host.stubSequence('POST', 'orders', [
            { status: 429, retryAfter: 1 },
            { status: 201, body: { id: 5 } },
        ]);

        const result = await bridge.request({
            method: 'POST', path: 'orders', body: { key: 'abc' }, retry: true,
        });

        expect(result.status).toBe(201);
        expect(result.attempts).toBe(2);
    });

    it('lets a caller opt a GET out', async () => {
        const bridge = await mount();
        host.stub('GET', 'orders', { status: 429 });

        const result = await bridge.request({ method: 'GET', path: 'orders', retry: false });

        expect(result.attempts).toBe(1);
    });

    it('does not retry a 500 — retrying a broken server just doubles the load', async () => {
        const bridge = await mount();
        host.stub('GET', 'orders', { status: 500 });

        const result = await bridge.request({ method: 'GET', path: 'orders' });

        expect(result.attempts).toBe(1);
    });

});

describe('rate-limit surfacing', () => {
    it('reports retryAfter and remaining from the proxy payload', async () => {
        const bridge = await mount();
        host.stub('GET', 'me', { status: 200, body: {}, retryAfter: 12, remaining: 39 });

        const result = await bridge.request({ method: 'GET', path: 'me' });

        expect(result.retryAfter).toBe(12);
        expect(result.remaining).toBe(39);
    });

    it('reports the full X-RateLimit family from direct response headers', async () => {
        const bridge = await mount({ directApi: true });
        host.onGraphql(() => ({
            status: 200, body: { data: {} }, retryAfter: 12, remaining: 39, limit: 60, reset: 1754800000,
        }));

        const result = await bridge.graphql('{ me { id } }');

        expect(result.retryAfter).toBe(12);
        expect(result.remaining).toBe(39);
        expect(result.limit).toBe(60);
        expect(result.reset).toBe(1754800000);
    });

    it('reports nulls rather than undefined when the host said nothing', async () => {
        const bridge = await mount();
        host.stub('GET', 'me', { status: 200, body: {} });

        const result = await bridge.request({ method: 'GET', path: 'me' });

        expect(result.retryAfter).toBeNull();
        expect(result.remaining).toBeNull();
    });
});

describe('lifecycle', () => {
    it('rejects a proxy request made after destroy', async () => {
        const bridge = await mount();
        bridge.destroy();
        await expect(bridge.request({ method: 'GET', path: 'me' })).rejects.toThrow(/destroyed/);
    });
});
