import { afterEach, describe, expect, it, vi } from 'vitest';

import { loadConfig } from '../server/config.js';
import { HostClientError, hostClientErrorHeaders, hostClientFor } from '../server/host-client.js';
import { DIRECT_TOKEN_HEADER, DIRECT_TOKEN_REJECTED_HEADER } from '../direct-fetch.js';

/**
 * hostClientFor (0.6.6): the per-request host client built from the browser's
 * direct token + `apiBase`, proven to belong to the session's profile before
 * anything uses it. Fails CLOSED on every doubt.
 */

const cfg = loadConfig({ FLASHMANDU_API_BASE: 'https://app.example.com', FLASHMANDU_API_TOKEN: 'pod_token' } as NodeJS.ProcessEnv);

function req(headers: Record<string, string> = {}, query = '?profileId=7'): Request {
    return new Request(`https://tours.example/api/x${query}`, { headers });
}

function meResponse(profileId: number): Response {
    return new Response(JSON.stringify({ app_id: 'tours', name: 'Tours', profile_id: profileId, scopes: ['write:media'], subscribed_events: [] }), {
        status: 200,
    });
}

afterEach(() => {
    vi.unstubAllGlobals();
});

describe('hostClientFor', () => {
    it('uses the direct token as Bearer against apiBase and caches the verified me()', async () => {
        const fetchMock = vi.fn(async () => meResponse(7));
        vi.stubGlobal('fetch', fetchMock);

        const client = await hostClientFor(req({ [DIRECT_TOKEN_HEADER]: 'direct_7' }), cfg);

        expect(client.profileId).toBe(7);
        expect(fetchMock).toHaveBeenCalledWith(
            'https://app.example.com/api/apps/me',
            expect.objectContaining({ headers: expect.objectContaining({ Authorization: 'Bearer direct_7' }) }),
        );
        await expect(client.me()).resolves.toMatchObject({ profile_id: 7 });
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('never falls back to the pod token when the header is missing', async () => {
        const fetchMock = vi.fn();
        vi.stubGlobal('fetch', fetchMock);
        const err = await hostClientFor(req(), cfg).catch((e: unknown) => e);
        expect(err).toBeInstanceOf(HostClientError);
        expect(err).toMatchObject({ code: 'direct_token_missing', status: 401 });
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it('refuses with 503 when no apiBase is configured', async () => {
        const err = await hostClientFor(req({ [DIRECT_TOKEN_HEADER]: 't' }), loadConfig({} as NodeJS.ProcessEnv)).catch((e: unknown) => e);
        expect(err).toMatchObject({ code: 'api_base_missing', status: 503 });
    });

    it('refuses with 401 when there is no session profile', async () => {
        const err = await hostClientFor(req({ [DIRECT_TOKEN_HEADER]: 't' }, ''), cfg).catch((e: unknown) => e);
        expect(err).toMatchObject({ code: 'no_session', status: 401 });
    });

    it('maps a host 401 on me() to direct_token_rejected (the browser re-mints once)', async () => {
        vi.stubGlobal('fetch', vi.fn(async () => new Response('{"error":"invalid_token"}', { status: 401 })));
        const err = await hostClientFor(req({ [DIRECT_TOKEN_HEADER]: 'stale' }), cfg).catch((e: unknown) => e);
        expect(err).toMatchObject({ code: 'direct_token_rejected', status: 401 });
        expect(hostClientErrorHeaders(err as HostClientError)).toEqual({ [DIRECT_TOKEN_REJECTED_HEADER]: '1' });
    });

    it('fails closed with 502 when me() cannot be read', async () => {
        vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('fetch failed'); }));
        const err = await hostClientFor(req({ [DIRECT_TOKEN_HEADER]: 't' }), cfg).catch((e: unknown) => e);
        expect(err).toMatchObject({ code: 'host_unreachable', status: 502 });
        expect(hostClientErrorHeaders(err as HostClientError)).toEqual({});
    });

    it('refuses with 403 when the token belongs to another profile', async () => {
        vi.stubGlobal('fetch', vi.fn(async () => meResponse(8)));
        const err = await hostClientFor(req({ [DIRECT_TOKEN_HEADER]: 'direct_8' }), cfg).catch((e: unknown) => e);
        expect(err).toMatchObject({ code: 'profile_mismatch', status: 403 });
    });

    it('checks against an explicit profileId when the caller already resolved one', async () => {
        vi.stubGlobal('fetch', vi.fn(async () => meResponse(7)));
        const err = await hostClientFor(req({ [DIRECT_TOKEN_HEADER]: 'direct_7' }, ''), cfg, { profileId: 9 }).catch((e: unknown) => e);
        expect(err).toMatchObject({ code: 'profile_mismatch', status: 403 });
    });

    it('sends media and graphql calls with the same direct token', async () => {
        const fetchMock = vi
            .fn()
            .mockResolvedValueOnce(meResponse(7))
            .mockResolvedValueOnce(new Response(JSON.stringify({ data: { ok: true } }), { status: 200 }));
        vi.stubGlobal('fetch', fetchMock);

        const client = await hostClientFor(req({ [DIRECT_TOKEN_HEADER]: 'direct_7' }), cfg);
        await client.graphql('query { ok }');

        expect(fetchMock.mock.calls[1]?.[0]).toBe('https://app.example.com/api/apps/graphql');
        expect((fetchMock.mock.calls[1]?.[1] as RequestInit).headers).toMatchObject({ Authorization: 'Bearer direct_7' });
    });
});
