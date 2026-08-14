import { createHmac } from 'node:crypto';

import { describe, expect, it, vi } from 'vitest';

import { loadConfig } from '../server/config.js';
import { createOAuthRoutes, createRevalidateHandler, createWebhookRoute } from '../next/routes.js';

function signedRequest(body: string, secret: string, delivery = 'd1', event = 'app.uninstalled') {
    const ts = String(Math.floor(Date.now() / 1000));
    const sig = createHmac('sha256', secret).update(`${ts}.${body}`).digest('hex');
    return new Request('https://app.example/webhooks/flashmandu', {
        method: 'POST',
        body,
        headers: {
            'x-app-event': event,
            'x-app-signature': sig,
            'x-app-timestamp': ts,
            'x-app-delivery': delivery,
        },
    });
}

describe('createWebhookRoute', () => {
    const cfg = loadConfig({ FLASHMANDU_WEBHOOK_SECRET: 'w' } as NodeJS.ProcessEnv);

    it('verifies, dispatches app.uninstalled to onUninstalled, and returns 200', async () => {
        const onUninstalled = vi.fn(async () => ({ models: 3, files: 12 }));
        const { POST } = createWebhookRoute({ cfg, onUninstalled });

        const body = JSON.stringify({ event: 'app.uninstalled', payload: { profile_id: 5 } });
        const req = signedRequest(body, 'w');

        const res = await POST(req);
        expect(res.status).toBe(200);
        const json = await res.json();
        expect(json).toMatchObject({ ok: true, handled: 'purged' });
        expect(onUninstalled).toHaveBeenCalledTimes(1);
        expect(onUninstalled).toHaveBeenCalledWith('5', {
            event: 'app.uninstalled',
            deliveryId: 'd1',
            payload: { profile_id: 5 },
        });
    });

    it('passes the delivery context (event, deliveryId, payload) as the second argument', async () => {
        const onUninstalled = vi.fn(async () => ({ models: 3 }));
        const { POST } = createWebhookRoute({ cfg, onUninstalled });

        const body = JSON.stringify({ event: 'profile.data.erased', payload: { profile_id: 9 } });
        const req = signedRequest(body, 'w', 'ctx-1', 'profile.data.erased');

        await POST(req);

        expect(onUninstalled).toHaveBeenCalledWith('9', {
            event: 'profile.data.erased',
            deliveryId: 'ctx-1',
            payload: { profile_id: 9 },
        });
    });

    it('still calls a legacy single-argument (profileId) => ... callback correctly', async () => {
        // Written exactly as pre-context-argument code declared it — TS still
        // accepts this against the widened `onUninstalled` type, and at
        // runtime JS simply ignores the extra `context` argument this
        // function never named a parameter for.
        const purged: Record<string, number>[] = [];
        async function legacyOnUninstalled(profileId: string): Promise<Record<string, number>> {
            purged.push({ profile: Number(profileId) });
            return { models: 1 };
        }
        const { POST } = createWebhookRoute({ cfg, onUninstalled: legacyOnUninstalled });

        const body = JSON.stringify({ event: 'app.uninstalled', payload: { profile_id: 7 } });
        const res = await POST(signedRequest(body, 'w', 'legacy-1'));

        expect(res.status).toBe(200);
        const json = await res.json();
        expect(json).toMatchObject({ ok: true, handled: 'purged' });
        expect(purged).toEqual([{ profile: 7 }]);
    });

    it('does not call the callback twice for a repeated X-App-Delivery', async () => {
        const onUninstalled = vi.fn(async () => ({ models: 1 }));
        const { POST } = createWebhookRoute({ cfg, onUninstalled });

        const body = JSON.stringify({ event: 'app.uninstalled', payload: { profile_id: 5 } });

        await POST(signedRequest(body, 'w', 'dup-1'));
        const second = await POST(signedRequest(body, 'w', 'dup-1'));

        expect(onUninstalled).toHaveBeenCalledTimes(1);
        const json = await second.json();
        expect(json).toMatchObject({ ok: true, status: 'duplicate' });
    });

    it('surfaces the verifier reason string in the 401 body on a bad signature', async () => {
        const { POST } = createWebhookRoute({ cfg });
        const body = JSON.stringify({ event: 'app.uninstalled', payload: {} });
        const req = signedRequest(body, 'wrong-secret');

        const res = await POST(req);
        expect(res.status).toBe(401);
        const json = await res.json();
        expect(json.reason).toBe('signature mismatch');
    });

    it('routes non-purge events to onEvent', async () => {
        const onEvent = vi.fn(async () => {});
        const { POST } = createWebhookRoute({ cfg, onEvent });
        const body = JSON.stringify({ event: 'item.updated', payload: { id: 1 } });
        const req = signedRequest(body, 'w', 'd2', 'item.updated');

        const res = await POST(req);
        expect(res.status).toBe(200);
        expect(onEvent).toHaveBeenCalledWith('item.updated', { id: 1 }, 'd2');
    });

    it('acknowledges (200) a purge event with no resolvable profile id', async () => {
        const onUninstalled = vi.fn(async () => ({}));
        const { POST } = createWebhookRoute({ cfg, onUninstalled });
        const body = JSON.stringify({ event: 'app.uninstalled', payload: {} });
        const req = signedRequest(body, 'w');

        const res = await POST(req);
        expect(res.status).toBe(200);
        expect(onUninstalled).not.toHaveBeenCalled();
        const json = await res.json();
        expect(json.handled).toBe('purge_skipped_no_profile');
    });

    it('uses a custom seenDelivery store when provided', async () => {
        const seen = new Set<string>();
        const seenDelivery = vi.fn(async (id: string) => {
            if (seen.has(id)) return true;
            seen.add(id);
            return false;
        });
        const onUninstalled = vi.fn(async () => ({ models: 1 }));
        const { POST } = createWebhookRoute({ cfg, onUninstalled, seenDelivery });

        const body = JSON.stringify({ event: 'app.uninstalled', payload: { profile_id: 1 } });
        await POST(signedRequest(body, 'w', 'custom-1'));
        await POST(signedRequest(body, 'w', 'custom-1'));

        expect(seenDelivery).toHaveBeenCalledTimes(2);
        expect(onUninstalled).toHaveBeenCalledTimes(1);
    });
});

describe('createOAuthRoutes', () => {
    const cfg = loadConfig({} as NodeJS.ProcessEnv);
    const { authorize, callback, token } = createOAuthRoutes(cfg);

    it('authorize redirects with a fresh code + the original state', async () => {
        const req = new Request(
            'https://app.example/oauth/authorize?client_id=c&redirect_uri=' +
                encodeURIComponent('https://host.example/cb') +
                '&state=s1&response_type=code',
        );
        const res = await authorize(req);
        expect(res.status).toBe(302);
        const location = new URL(res.headers.get('location') ?? '');
        expect(location.searchParams.get('state')).toBe('s1');
        expect(location.searchParams.get('code')).toBeTruthy();
    });

    it('authorize rejects a missing required param', async () => {
        const req = new Request('https://app.example/oauth/authorize?client_id=c');
        const res = await authorize(req);
        expect(res.status).toBe(400);
    });

    it('callback reports the developer-convenience landing message', async () => {
        const req = new Request('https://app.example/oauth/callback');
        const res = await callback(req);
        const json = await res.json();
        expect(json.message).toMatch(/developer convenience/);
    });

    it('token exchanges an authorization_code grant for an opaque access token', async () => {
        const req = new Request('https://app.example/oauth/token', {
            method: 'POST',
            body: JSON.stringify({ grant_type: 'authorization_code', code: 'abc', code_verifier: 'v' }),
        });
        const res = await token(req);
        const json = await res.json();
        expect(json.token_type).toBe('bearer');
        expect(json.access_token).toBeTruthy();
    });
});

describe('createRevalidateHandler', () => {
    it('always resolves 200, even when devBoxBaseUrl is unset', async () => {
        const cfg = loadConfig({} as NodeJS.ProcessEnv);
        const handler = createRevalidateHandler(cfg);
        const req = new Request('https://app.example/revalidate', {
            method: 'POST',
            body: JSON.stringify({ profile_id: 1 }),
        });
        const res = await handler(req);
        expect(res.status).toBe(200);
    });
});
