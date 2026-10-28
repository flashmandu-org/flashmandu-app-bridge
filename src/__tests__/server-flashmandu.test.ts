import { afterEach, describe, expect, it, vi } from 'vitest';

import {
    createFlashmanduClient,
    FlashmanduMediaError,
    MediaInvalidError,
    MediaQuotaError,
    MediaScopeError,
    MediaTooLargeError,
} from '../server/flashmandu.js';

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

/**
 * 0.6.4 — media.upload / media.delete. The host contract is FIXED:
 *   POST /api/apps/media (multipart: file, collection, alt; Bearer token)
 *     201 {id, url, filename, mimeType, size, collection}
 *     403 / 413 / 422 / 507 {error, message}
 *   GraphQL deleteMediaItem(id: ID!): Boolean! (only items this app added).
 * Every app gets these from the kit, so apps never hand-roll a multipart call.
 */
describe('createFlashmanduClient().media', () => {
    afterEach(() => {
        vi.unstubAllGlobals();
    });

    const created = {
        id: 77,
        url: 'https://cdn.example/m/77.jpg',
        filename: 'pano.jpg',
        mimeType: 'image/jpeg',
        size: 3,
        collection: 'tours',
    };

    it('uploads a Buffer as multipart file/collection/alt with the Bearer token and returns the created item', async () => {
        const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) =>
            new Response(JSON.stringify(created), { status: 201 }),
        );
        vi.stubGlobal('fetch', fetchMock);

        const client = createFlashmanduClient({ apiBase: 'https://dev.example', token: 'tok' });
        const media = await client.media.upload(Buffer.from([1, 2, 3]), {
            filename: 'pano.jpg',
            collection: 'tours',
            alt: 'Lobby',
        });

        expect(media).toEqual(created);
        const [url, init] = fetchMock.mock.calls[0]!;
        expect(url).toBe('https://dev.example/api/apps/media');
        expect(init?.method).toBe('POST');
        const headers = init?.headers as Record<string, string>;
        expect(headers.Authorization).toBe('Bearer tok');
        // fetch must set the multipart boundary itself.
        expect(Object.keys(headers).map((h) => h.toLowerCase())).not.toContain('content-type');
        const form = init?.body as FormData;
        expect(form).toBeInstanceOf(FormData);
        const file = form.get('file') as File;
        expect(file.name).toBe('pano.jpg');
        expect(file.type).toBe('image/jpeg');
        expect(new Uint8Array(await file.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]));
        expect(form.get('collection')).toBe('tours');
        expect(form.get('alt')).toBe('Lobby');
    });

    it('accepts a Blob/File and omits collection and alt when not given', async () => {
        const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) =>
            new Response(JSON.stringify({ ...created, collection: 'default' }), { status: 201 }),
        );
        vi.stubGlobal('fetch', fetchMock);

        const client = createFlashmanduClient({ apiBase: 'https://dev.example', token: 'tok' });
        await client.media.upload(new Blob([new Uint8Array([9])], { type: 'image/png' }), { filename: 'a.png' });

        const form = fetchMock.mock.calls[0]![1]?.body as FormData;
        expect((form.get('file') as File).name).toBe('a.png');
        expect((form.get('file') as File).type).toBe('image/png');
        expect(form.has('collection')).toBe(false);
        expect(form.has('alt')).toBe(false);
    });

    it('sends visibility when given (public items carry a url)', async () => {
        const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) =>
            new Response(JSON.stringify(created), { status: 201 }),
        );
        vi.stubGlobal('fetch', fetchMock);
        const client = createFlashmanduClient({ apiBase: 'https://dev.example', token: 'tok' });
        await client.media.upload(Buffer.from([1]), { filename: 'p.jpg', visibility: 'public' });
        expect((fetchMock.mock.calls[0]![1]?.body as FormData).get('visibility')).toBe('public');
    });

    it('leaves visibility unset by default so the host default (private) applies, and a private item resolves with url null', async () => {
        const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) =>
            new Response(JSON.stringify({ ...created, url: null }), { status: 201 }),
        );
        vi.stubGlobal('fetch', fetchMock);
        const client = createFlashmanduClient({ apiBase: 'https://dev.example', token: 'tok' });
        const item = await client.media.upload(Buffer.from([1]), { filename: 'p.jpg' });
        expect((fetchMock.mock.calls[0]![1]?.body as FormData).has('visibility')).toBe(false);
        expect(item.url).toBeNull();
        expect(item.id).toBe(77);
    });

    it('requires a filename', async () => {
        const client = createFlashmanduClient({ apiBase: 'https://dev.example', token: 'tok' });
        await expect(client.media.upload(Buffer.from([1]), { filename: '' })).rejects.toThrow(/filename/);
    });

    it.each([
        [403, 'scope_denied', MediaScopeError, 'missing_scope', 'The app lacks write:media.'],
        [413, 'too_large', MediaTooLargeError, 'file_too_large', 'Files may be at most 50 MB.'],
        [422, 'invalid', MediaInvalidError, 'invalid_file', 'The file must be an image.'],
        [507, 'quota_exceeded', MediaQuotaError, 'quota_exceeded', 'Storage quota of 5 GB is used up.'],
    ] as const)('maps HTTP %i to a typed %s error carrying the host message', async (status, code, Klass, slug, message) => {
        vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: slug, message }), { status })));

        const client = createFlashmanduClient({ apiBase: 'https://dev.example', token: 'tok' });
        const err = await client.media.upload(Buffer.from([1]), { filename: 'x.jpg' }).catch((e: unknown) => e);

        expect(err).toBeInstanceOf(Klass);
        expect(err).toBeInstanceOf(FlashmanduMediaError);
        expect(err).toBeInstanceOf(Error);
        const e = err as FlashmanduMediaError;
        expect(e.code).toBe(code);
        expect(e.status).toBe(status);
        expect(e.serverCode).toBe(slug);
        expect(e.message).toBe(message);
    });

    it('an unexpected status is a FlashmanduMediaError with code http', async () => {
        vi.stubGlobal('fetch', vi.fn(async () => new Response('oops', { status: 500 })));
        const client = createFlashmanduClient({ apiBase: 'https://dev.example', token: 'tok' });
        const err = (await client.media.upload(Buffer.from([1]), { filename: 'x.jpg' }).catch((e: unknown) => e)) as FlashmanduMediaError;
        expect(err).toBeInstanceOf(FlashmanduMediaError);
        expect(err.code).toBe('http');
        expect(err.status).toBe(500);
    });

    it('a fetch that never completes is code network with no status', async () => {
        vi.stubGlobal('fetch', vi.fn(async () => {
            throw new TypeError('fetch failed');
        }));
        const client = createFlashmanduClient({ apiBase: 'https://dev.example', token: 'tok' });
        const err = (await client.media.upload(Buffer.from([1]), { filename: 'x.jpg' }).catch((e: unknown) => e)) as FlashmanduMediaError;
        expect(err).toBeInstanceOf(FlashmanduMediaError);
        expect(err.code).toBe('network');
        expect(err.status).toBeNull();
    });

    it('delete() runs the deleteMediaItem mutation with a string id and returns its boolean', async () => {
        const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) =>
            new Response(JSON.stringify({ data: { deleteMediaItem: true } }), { status: 200 }),
        );
        vi.stubGlobal('fetch', fetchMock);

        const client = createFlashmanduClient({ apiBase: 'https://dev.example', token: 'tok' });
        await expect(client.media.delete(77)).resolves.toBe(true);

        const [url, init] = fetchMock.mock.calls[0]!;
        expect(url).toBe('https://dev.example/api/apps/graphql');
        const body = JSON.parse(String(init?.body)) as { query: string; variables: { id: string } };
        expect(body.query).toMatch(/deleteMediaItem\(id: \$id\)/);
        expect(body.variables).toEqual({ id: '77' });
    });

    it('delete() surfaces a GraphQL refusal (an item this app did not add)', async () => {
        vi.stubGlobal('fetch', vi.fn(async () =>
            new Response(JSON.stringify({ errors: [{ message: 'This action is unauthorized.' }] }), { status: 200 }),
        ));
        const client = createFlashmanduClient({ apiBase: 'https://dev.example', token: 'tok' });
        await expect(client.media.delete(5)).rejects.toThrow(/unauthorized/);
    });
});
