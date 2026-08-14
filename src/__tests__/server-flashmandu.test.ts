import { afterEach, describe, expect, it, vi } from 'vitest';

import { createFlashmanduClient } from '../server/flashmandu.js';

describe('createFlashmanduClient', () => {
    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it('sends a bearer-authorized GET to me()', async () => {
        const fetchMock = vi.fn(async () =>
            new Response(JSON.stringify({ app_id: 'a', name: 'n', profile_id: 1, scopes: [], subscribed_events: [] }), {
                status: 200,
            }),
        );
        vi.stubGlobal('fetch', fetchMock);

        const client = createFlashmanduClient({ apiBase: 'https://dev.example', token: 'tok' });
        const me = await client.me();

        expect(me.app_id).toBe('a');
        expect(fetchMock).toHaveBeenCalledWith(
            'https://dev.example/api/apps/me',
            expect.objectContaining({
                headers: expect.objectContaining({ Authorization: 'Bearer tok' }),
            }),
        );
    });

    it('posts graphql queries to /api/apps/graphql and unwraps data', async () => {
        const fetchMock = vi.fn(async () =>
            new Response(JSON.stringify({ data: { hello: 'world' } }), { status: 200 }),
        );
        vi.stubGlobal('fetch', fetchMock);

        const client = createFlashmanduClient({ apiBase: 'https://dev.example', token: 'tok' });
        const result = await client.graphql<{ hello: string }>('query { hello }');

        expect(result).toEqual({ hello: 'world' });
        expect(fetchMock).toHaveBeenCalledWith(
            'https://dev.example/api/apps/graphql',
            expect.objectContaining({ method: 'POST' }),
        );
    });

    it('throws when the response carries graphql errors', async () => {
        const fetchMock = vi.fn(async () =>
            new Response(JSON.stringify({ errors: [{ message: 'nope' }] }), { status: 200 }),
        );
        vi.stubGlobal('fetch', fetchMock);

        const client = createFlashmanduClient({ apiBase: 'https://dev.example', token: 'tok' });
        await expect(client.graphql('query { hello }')).rejects.toThrow(/nope/);
    });

    it('throws on a non-ok response', async () => {
        const fetchMock = vi.fn(async () => new Response('bad', { status: 500, statusText: 'Server Error' }));
        vi.stubGlobal('fetch', fetchMock);

        const client = createFlashmanduClient({ apiBase: 'https://dev.example', token: 'tok' });
        await expect(client.me()).rejects.toThrow(/500/);
    });
});
