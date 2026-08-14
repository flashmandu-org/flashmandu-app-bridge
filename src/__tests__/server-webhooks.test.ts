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
});
