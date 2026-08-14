import { createHmac } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { verifyWebhook } from '../server/webhooks.js';

describe('verifyWebhook', () => {
    const secret = 'w';
    const body = JSON.stringify({ hello: 'world' });
    const ts = String(Math.floor(Date.now() / 1000));
    const sig = createHmac('sha256', secret).update(`${ts}.${body}`).digest('hex');
    const headers = {
        'x-app-event': 'app.uninstalled',
        'x-app-signature': sig,
        'x-app-timestamp': ts,
        'x-app-delivery': 'd1',
    };

    it('accepts a correctly signed delivery', () => {
        expect(verifyWebhook({ rawBody: body, headers, secret })).toMatchObject({
            ok: true,
            event: 'app.uninstalled',
            deliveryId: 'd1',
        });
    });

    it('rejects a tampered body', () => {
        expect(verifyWebhook({ rawBody: `${body} `, headers, secret }).ok).toBe(false);
    });

    it('accepts a Headers instance too', () => {
        expect(verifyWebhook({ rawBody: body, headers: new Headers(headers), secret }).ok).toBe(true);
    });

    it('reports the exact "signature mismatch" reason string (PHP-parity contract)', () => {
        const result = verifyWebhook({ rawBody: `${body} `, headers, secret });
        expect(result).toMatchObject({ ok: false, reason: 'signature mismatch' });
    });

    it('reports the exact "missing X-App-Signature or X-App-Timestamp" reason string', () => {
        const result = verifyWebhook({
            rawBody: body,
            headers: { 'x-app-event': 'app.uninstalled' },
            secret,
        });
        expect(result).toMatchObject({ ok: false, reason: 'missing X-App-Signature or X-App-Timestamp' });
    });

    it('rejects a non-numeric timestamp with the exact reason string', () => {
        const result = verifyWebhook({
            rawBody: body,
            headers: { ...headers, 'x-app-timestamp': '123abc' },
            secret,
        });
        expect(result).toMatchObject({ ok: false, reason: 'X-App-Timestamp is not a unix timestamp' });
    });

    it('rejects a timestamp outside the skew window', () => {
        const staleTs = String(Number(ts) - 10_000);
        const staleSig = createHmac('sha256', secret).update(`${staleTs}.${body}`).digest('hex');
        const result = verifyWebhook({
            rawBody: body,
            headers: { ...headers, 'x-app-timestamp': staleTs, 'x-app-signature': staleSig },
            secret,
        });
        expect(result.ok).toBe(false);
        expect(result.reason).toMatch(/timestamp skew \d+s exceeds the 300s window/);
    });

    it('honours an injected `now` for deterministic skew assertions', () => {
        const fixedNow = Number(ts) + 100;
        const result = verifyWebhook({ rawBody: body, headers, secret, now: fixedNow });
        expect(result.ok).toBe(true);
    });

    it('treats an empty header value as absent, not as an empty signature', () => {
        const result = verifyWebhook({
            rawBody: body,
            headers: { ...headers, 'x-app-signature': '' },
            secret,
        });
        expect(result.reason).toBe('missing X-App-Signature or X-App-Timestamp');
    });

    describe('plain-object headers are never routed through `new Headers()`', () => {
        // Regression coverage for a faithfulness bug found while porting
        // showcase's verifier suite: `verifyWebhook` used to normalize every
        // header bag — `Headers` instance OR plain object — by forcing it
        // through `new Headers(...)`. Node's `Headers` silently trims
        // surrounding whitespace, silently strips embedded newlines, and
        // throws on non-Latin-1 bytes. A caller handing a plain
        // `Record<string, string>` (e.g. one it parsed off the wire itself)
        // got mangled input or an uncaught exception instead of the clean
        // `{ ok: false, reason }` the verifier contractually promises. Fixed
        // by reading a plain object verbatim and case-insensitively, without
        // ever constructing a `Headers` from it.
        function verifyRawTimestamp(header: string) {
            const raw = body;
            const sig = createHmac('sha256', secret).update(`${header}.${raw}`).digest('hex');
            return verifyWebhook({
                rawBody: raw,
                headers: {
                    'x-app-signature': sig,
                    'x-app-timestamp': header,
                    'x-app-delivery': 'd-ts',
                    'x-app-event': 'app.uninstalled',
                },
                secret,
            });
        }

        it('does not trim a leading space, so the mismatched signature is what fails, not a silently-repaired timestamp', () => {
            // `new Headers()` used to trim this to '1800000000', which is a
            // valid timestamp — so verification fell through to the HMAC
            // check and reported 'signature mismatch' for the wrong reason
            // (the signature was computed over the untrimmed string, and
            // still is; the point is the value must reach the timestamp
            // check un-mangled).
            expect(verifyRawTimestamp(' 1800000000').reason).toBe('X-App-Timestamp is not a unix timestamp');
        });

        it('does not trim a trailing space', () => {
            expect(verifyRawTimestamp('1800000000 ').reason).toBe('X-App-Timestamp is not a unix timestamp');
        });

        it('does not strip an embedded newline', () => {
            expect(verifyRawTimestamp('1800000000\n').reason).toBe('X-App-Timestamp is not a unix timestamp');
        });

        it('rejects non-Latin-1 timestamp bytes cleanly instead of throwing', () => {
            // '١٨٠٠' — Arabic-Indic digits. `new Headers()` throws
            // `TypeError: Cannot convert argument to a ByteString` on these;
            // a verifier must never throw on attacker-controlled input.
            expect(() => verifyRawTimestamp('١٨٠٠')).not.toThrow();
            expect(verifyRawTimestamp('١٨٠٠')).toMatchObject({
                ok: false,
                reason: 'X-App-Timestamp is not a unix timestamp',
            });
        });
    });
});
