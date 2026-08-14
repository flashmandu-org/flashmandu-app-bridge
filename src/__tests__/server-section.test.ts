import { createHmac } from 'node:crypto';

import { describe, expect, it, vi } from 'vitest';

import { loadConfig } from '../server/config.js';
import { createSectionRoute } from '../next/routes.js';
import {
    SECTION_SCHEMA_VERSION,
    canonicalQuery,
    readSectionContext,
    sectionResponseBody,
    signSectionRequest,
    verifySectionRequest,
} from '../server/section.js';

const SECRET = 'w';

/**
 * Build the request the PLATFORM would send: canonical query, HMAC over
 * `"{ts}.{canonicalQuery}"`, headers named exactly as webhook delivery names
 * them. Written independently of `signSectionRequest` (raw `createHmac`) so a
 * bug in the signer cannot make its own tests pass.
 */
function signedSectionRequest(
    params: Record<string, string>,
    { secret = SECRET, ts = String(Math.floor(Date.now() / 1000)), section = 'events-calendar' } = {},
): Request {
    const url = new URL('https://app.example/sections/events');
    for (const [key, value] of Object.entries(params)) {
        url.searchParams.set(key, value);
    }

    const sig = createHmac('sha256', secret)
        .update(`${ts}.${canonicalQuery(url.searchParams)}`)
        .digest('hex');

    return new Request(url.toString(), {
        headers: {
            'x-app-timestamp': ts,
            'x-app-signature': sig,
            'x-app-section': section,
        },
    });
}

describe('canonicalQuery', () => {
    it('sorts by key and is stable regardless of parameter order', () => {
        expect(canonicalQuery(new URLSearchParams('b=2&a=1'))).toBe('a=1&b=2');
        expect(canonicalQuery(new URLSearchParams('a=1&b=2'))).toBe('a=1&b=2');
    });

    it('normalizes + and %20 to the same canonical form', () => {
        // Two HTTP stacks will not agree on which one they emit; both sides
        // decode first, so both agree on what it means.
        expect(canonicalQuery(new URLSearchParams('q=a+b'))).toBe(
            canonicalQuery(new URLSearchParams('q=a%20b')),
        );
    });

    it("percent-encodes !'()* the way PHP rawurlencode does", () => {
        // encodeURIComponent leaves these five alone; PHP does not. A settings
        // value containing one would otherwise fail with "signature mismatch".
        expect(canonicalQuery({ q: "!'()*" })).toBe('q=%21%27%28%29%2A');
    });

    it('accepts a plain record and stringifies booleans', () => {
        expect(canonicalQuery({ a: 1, b: true, c: false })).toBe('a=1&b=true&c=false');
    });
});

describe('verifySectionRequest', () => {
    it('accepts a correctly signed request', () => {
        const req = signedSectionRequest({ profile_id: '5', settings: '{"months":2}' });

        expect(verifySectionRequest({ url: req.url, headers: req.headers, secret: SECRET }).ok).toBe(true);
    });

    it('rejects a bad signature with the verifier reason string', () => {
        const req = signedSectionRequest({ profile_id: '5' }, { secret: 'wrong' });

        const verdict = verifySectionRequest({ url: req.url, headers: req.headers, secret: SECRET });

        expect(verdict.ok).toBe(false);
        // Byte-identical to the webhook verifier's own string — one sentence
        // in the app's logs and the platform's inspector, not two.
        expect(verdict.reason).toBe('signature mismatch');
    });

    it('rejects missing headers, a non-numeric timestamp and excess skew with the webhook reasons', () => {
        const bare = new Request('https://app.example/sections/events?profile_id=5');
        expect(verifySectionRequest({ url: bare.url, headers: bare.headers, secret: SECRET }).reason).toBe(
            'missing X-App-Signature or X-App-Timestamp',
        );

        const bad = signedSectionRequest({ profile_id: '5' }, { ts: 'not-a-timestamp' });
        expect(verifySectionRequest({ url: bad.url, headers: bad.headers, secret: SECRET }).reason).toBe(
            'X-App-Timestamp is not a unix timestamp',
        );

        const old = signedSectionRequest({ profile_id: '5' }, { ts: '1000' });
        expect(
            verifySectionRequest({ url: old.url, headers: old.headers, secret: SECRET, now: 2000 }).reason,
        ).toBe('timestamp skew 1000s exceeds the 300s window');
    });

    it('rejects a request whose query was tampered with after signing', () => {
        const req = signedSectionRequest({ profile_id: '5' });
        const tampered = `${req.url}&profile_id=6`;

        expect(verifySectionRequest({ url: tampered, headers: req.headers, secret: SECRET }).ok).toBe(false);
    });

    it('round-trips with signSectionRequest', () => {
        const url = 'https://app.example/sections/events?profile_id=5&settings=%7B%7D';
        const ts = Math.floor(Date.now() / 1000);

        const verdict = verifySectionRequest({
            url,
            headers: { 'x-app-timestamp': String(ts), 'x-app-signature': signSectionRequest(url, ts, SECRET) },
            secret: SECRET,
        });

        expect(verdict.ok).toBe(true);
    });
});

describe('readSectionContext', () => {
    it('reads the profile, settings, section type and schema version', () => {
        const req = signedSectionRequest({
            profile_id: '7',
            settings: '{"months_ahead":3}',
            schema_version: '1',
        });

        expect(readSectionContext(req.url, req.headers)).toEqual({
            profileId: '7',
            settings: { months_ahead: 3 },
            sectionType: 'events-calendar',
            schemaVersion: 1,
        });
    });

    it('falls back to empty settings rather than throwing on a malformed blob', () => {
        const req = signedSectionRequest({ profile_id: '7', settings: 'not json' });

        // A section rendering with defaults beats a 500 on a live storefront.
        expect(readSectionContext(req.url, req.headers).settings).toEqual({});
    });

    it('ignores a non-object settings blob', () => {
        const req = signedSectionRequest({ profile_id: '7', settings: '[1,2,3]' });

        expect(readSectionContext(req.url, req.headers).settings).toEqual({});
    });
});

describe('sectionResponseBody', () => {
    it('stamps the schema version and maps staleTtl to the wire name', () => {
        expect(sectionResponseBody({ tree: [{ type: 'heading' }], cache: { ttl: 300, staleTtl: 86_400 } })).toEqual({
            schema_version: SECTION_SCHEMA_VERSION,
            tree: [{ type: 'heading' }],
            cache: { ttl: 300, stale_ttl: 86_400 },
        });
    });

    it('omits cache entirely when the app suggests nothing', () => {
        expect(sectionResponseBody({ tree: [] })).toEqual({
            schema_version: SECTION_SCHEMA_VERSION,
            tree: [],
        });
    });
});

describe('createSectionRoute', () => {
    const cfg = loadConfig({ FLASHMANDU_WEBHOOK_SECRET: SECRET } as NodeJS.ProcessEnv);

    it('verifies, hands the handler the authenticated context, and shapes the response', async () => {
        const handler = vi.fn(async () => ({
            tree: [{ type: 'heading', props: { text: 'Upcoming' } }],
            cache: { ttl: 300, staleTtl: 86_400 },
        }));

        const { GET } = createSectionRoute({ cfg, handler });

        const res = await GET(
            signedSectionRequest({ profile_id: '5', settings: '{"months_ahead":2}', schema_version: '1' }),
        );

        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({
            schema_version: 1,
            tree: [{ type: 'heading', props: { text: 'Upcoming' } }],
            cache: { ttl: 300, stale_ttl: 86_400 },
        });

        expect(handler).toHaveBeenCalledWith({
            profileId: '5',
            settings: { months_ahead: 2 },
            sectionType: 'events-calendar',
            schemaVersion: 1,
        });

        // The PLATFORM owns caching here; a second clock in an intermediary
        // would leave the merchant with two and no way to reason about either.
        expect(res.headers.get('cache-control')).toBe('no-store');
    });

    it('refuses a bad signature with 401 and the verifier reason string', async () => {
        const handler = vi.fn(async () => ({ tree: [] }));
        const { GET } = createSectionRoute({ cfg, handler });

        const res = await GET(signedSectionRequest({ profile_id: '5' }, { secret: 'wrong' }));

        expect(res.status).toBe(401);
        expect(await res.json()).toEqual({ ok: false, error: 'signature mismatch' });
        expect(handler).not.toHaveBeenCalled();
    });

    it('refuses an unsigned request without ever calling the handler', async () => {
        const handler = vi.fn(async () => ({ tree: [] }));
        const { GET } = createSectionRoute({ cfg, handler });

        const res = await GET(new Request('https://app.example/sections/events?profile_id=5'));

        expect(res.status).toBe(401);
        expect(await res.json()).toEqual({ ok: false, error: 'missing X-App-Signature or X-App-Timestamp' });
        expect(handler).not.toHaveBeenCalled();
    });

    it('answers 500 without leaking handler internals when the handler throws', async () => {
        const { GET } = createSectionRoute({
            cfg,
            handler: () => {
                throw new Error('DB password rotated: postgres://user:hunter2@db');
            },
        });

        const res = await GET(signedSectionRequest({ profile_id: '5' }));
        const body = await res.json();

        expect(res.status).toBe(500);
        expect(body).toEqual({ ok: false, error: 'section handler failed' });
        expect(JSON.stringify(body)).not.toContain('hunter2');
    });

    it('accepts a synchronous handler', async () => {
        const { GET } = createSectionRoute({ cfg, handler: () => ({ tree: [{ type: 'text' }] }) });

        const res = await GET(signedSectionRequest({ profile_id: '5' }));

        expect(res.status).toBe(200);
        expect((await res.json()).tree).toEqual([{ type: 'text' }]);
    });
});
