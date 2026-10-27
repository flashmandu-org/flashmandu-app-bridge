import { describe, expect, it, vi } from 'vitest';

/**
 * `chooseMedia` — the ONE app-side wrapper that turns a `pickMedia()` outcome
 * into "a url, or null after telling the merchant why". Before it, every app
 * (Interactive Map's MapForm, Tours) hand-wrote the same four branches.
 *
 * Doctrine: a cancel is silent; a missing `read:media` grant is explained; any
 * other host refusal is reported; it never throws into a form, even if the
 * picker itself rejects.
 */

const { chooseMedia } = await import('../react/host-dialogs.js');

describe('chooseMedia', () => {
    it('returns the picked url and label without a toast', async () => {
        const toast = vi.fn();
        const got = await chooseMedia(toast, async () => ({ status: 'picked', id: 7, url: 'https://m/x.jpg', label: 'x.jpg' }));
        expect(got).toEqual({ id: 7, url: 'https://m/x.jpg', label: 'x.jpg' });
        expect(toast).not.toHaveBeenCalled();
    });

    it('is silent on cancel', async () => {
        const toast = vi.fn();
        expect(await chooseMedia(toast, async () => ({ status: 'cancelled' }))).toBeNull();
        expect(toast).not.toHaveBeenCalled();
    });

    it('explains a scope denial', async () => {
        const toast = vi.fn();
        expect(await chooseMedia(toast, async () => ({ status: 'denied' }))).toBeNull();
        expect(toast).toHaveBeenCalledWith('This app has not been granted access to your media library.', 'error');
    });

    it('reports an unavailable picker', async () => {
        const toast = vi.fn();
        expect(await chooseMedia(toast, async () => ({ status: 'unavailable', reason: 'busy' }))).toBeNull();
        expect(toast).toHaveBeenCalledWith('The media picker is unavailable right now.', 'error');
    });

    it('treats a picker that rejects anyway as unavailable, never throwing', async () => {
        const toast = vi.fn();
        expect(await chooseMedia(toast, async () => Promise.reject(new Error('boom')))).toBeNull();
        expect(toast).toHaveBeenCalledWith('The media picker is unavailable right now.', 'error');
    });

    it('is exported from the react entry point', async () => {
        const entry = await import('../react/index.js');
        expect(typeof entry.chooseMedia).toBe('function');
    });
});
