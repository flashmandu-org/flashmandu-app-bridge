import { describe, expect, it, vi } from 'vitest';

import { BridgeValidationError, normalisePageChrome, pageChromeEquals } from '../page-chrome.js';
import { publishPageChrome } from '../react/use-page-chrome.js';
import type { SetPagePayload } from '../types.js';

/**
 * 0.6.3 — SET_PAGE carries `overlay` while an in-app drawer is open, so the
 * HOST can dim its own left sidebar too (the iframe can only dim itself).
 * Optional and boolean; it must survive normalisation (the payload is rebuilt
 * key by key, so an unknown key would be stripped) and a flip must re-post.
 */

const base: SetPagePayload = { crumbs: [], actions: [], dirty: false };

describe('SET_PAGE overlay', () => {
    it('keeps overlay true and false through normalisation, omits it when absent', () => {
        expect(normalisePageChrome({ ...base, overlay: true }).overlay).toBe(true);
        expect(normalisePageChrome({ ...base, overlay: false }).overlay).toBe(false);
        expect('overlay' in normalisePageChrome(base)).toBe(false);
    });

    it('rejects a non-boolean overlay', () => {
        expect(() => normalisePageChrome({ ...base, overlay: 'yes' as unknown as boolean })).toThrow(
            BridgeValidationError,
        );
    });

    it('an overlay flip is a different payload, so it re-posts', () => {
        expect(pageChromeEquals({ ...base, overlay: false }, { ...base, overlay: true })).toBe(false);
        const sink = { setPage: vi.fn() };
        const first = publishPageChrome({ ...base, overlay: false }, null, sink);
        publishPageChrome({ ...base, overlay: true }, first, sink);
        expect(sink.setPage).toHaveBeenCalledTimes(2);
        expect(sink.setPage.mock.calls[1]![0]).toMatchObject({ overlay: true });
    });
});
