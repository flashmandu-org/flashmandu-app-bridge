import { afterEach, describe, expect, it, vi } from 'vitest';

import { loadConfig } from '../server/config.js';
import { revalidateProfile } from '../server/revalidate.js';

describe('revalidateProfile', () => {
    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it('posts the profile id to the platform revalidate endpoint', async () => {
        const fetchMock = vi.fn(async () => new Response(null, { status: 200 }));
        vi.stubGlobal('fetch', fetchMock);

        const cfg = loadConfig({
            FLASHMANDU_API_TOKEN: 'tok',
            FLASHMANDU_DEV_BOX_BASE_URL: 'https://dev.example/',
        } as NodeJS.ProcessEnv);

        await revalidateProfile(cfg, 42);

        expect(fetchMock).toHaveBeenCalledWith(
            'https://dev.example/api/apps/embed/revalidate',
            expect.objectContaining({
                method: 'POST',
                headers: expect.objectContaining({ Authorization: 'Bearer tok' }),
                body: JSON.stringify({ profile_id: 42 }),
            }),
        );
    });

    it('posts an empty body when no profile id is given', async () => {
        const fetchMock = vi.fn(async () => new Response(null, { status: 200 }));
        vi.stubGlobal('fetch', fetchMock);

        const cfg = loadConfig({
            FLASHMANDU_API_TOKEN: 'tok',
            FLASHMANDU_DEV_BOX_BASE_URL: 'https://dev.example/',
        } as NodeJS.ProcessEnv);

        await revalidateProfile(cfg);

        expect(fetchMock).toHaveBeenCalledWith(
            'https://dev.example/api/apps/embed/revalidate',
            expect.objectContaining({ body: JSON.stringify({}) }),
        );
    });

    it('never fires on a platform pod (FLASHMANDU_API_BASE only): the pod token is one install, not every store', async () => {
        const fetchMock = vi.fn(async () => new Response(null, { status: 200 }));
        vi.stubGlobal('fetch', fetchMock);

        const cfg = loadConfig({ FLASHMANDU_API_TOKEN: 'tok', FLASHMANDU_API_BASE: 'https://app.example.com' } as NodeJS.ProcessEnv);
        await revalidateProfile(cfg, 42);

        expect(fetchMock).not.toHaveBeenCalled();
    });

    it('is a no-op when devBoxBaseUrl is unset', async () => {
        const fetchMock = vi.fn();
        vi.stubGlobal('fetch', fetchMock);

        const cfg = loadConfig({} as NodeJS.ProcessEnv);

        await expect(revalidateProfile(cfg, 1)).resolves.toBeUndefined();
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it('never throws when the upstream call fails', async () => {
        const fetchMock = vi.fn(async () => {
            throw new Error('network down');
        });
        vi.stubGlobal('fetch', fetchMock);

        const cfg = loadConfig({
            FLASHMANDU_API_TOKEN: 'tok',
            FLASHMANDU_DEV_BOX_BASE_URL: 'https://dev.example/',
        } as NodeJS.ProcessEnv);

        await expect(revalidateProfile(cfg, 1)).resolves.toBeUndefined();
    });
});
