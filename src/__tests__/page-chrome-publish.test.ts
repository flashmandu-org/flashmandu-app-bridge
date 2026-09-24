import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { publishPageChrome, resetPageChromeErrors } from '../react/use-page-chrome.js';
import type { SetPagePayload } from '../types.js';

/**
 * PG-329a — the effect body of `usePageChrome`.
 *
 * 1. A payload the host would drop must be LOUD: before this, the throw from
 *    `normalisePageChrome` inside a React effect either blanked the app or was
 *    eaten by an error boundary, and the merchant just saw no Save button.
 * 2. A form going dirty (or its Save going busy) must re-post SET_PAGE — the
 *    host hides ⌘K and shows Save/Discard off `dirty`, so a deduped-away flip
 *    leaves the command bar lying.
 */

const save = { id: 'submit', label: 'Save', variant: 'primary' as const, disabled: true, loading: false };
const cancel = { id: 'cancel', label: 'Cancel', variant: 'ghost' as const };
const page = (over: Partial<SetPagePayload> = {}): SetPagePayload => ({
    title: 'Edit tour',
    crumbs: [{ label: 'Tours', path: '/tours' }, { label: 'Edit' }],
    actions: [save, cancel],
    dirty: false,
    ...over,
});

let sink: { setPage: ReturnType<typeof vi.fn> };
let error: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
    sink = { setPage: vi.fn() };
    error = vi.spyOn(console, 'error').mockImplementation(() => {});
    resetPageChromeErrors();
});

afterEach(() => {
    error.mockRestore();
});

describe('publishPageChrome — a failed SET_PAGE is loud, never silent', () => {
    it('does not throw, posts nothing, and console.errors the reason', () => {
        const bad = page({ actions: [{ ...save, label: 'x'.repeat(49) }, cancel] });

        let last: SetPagePayload | null = null;
        expect(() => {
            last = publishPageChrome(bad, null, sink);
        }).not.toThrow();

        expect(last).toBeNull();
        expect(sink.setPage).not.toHaveBeenCalled();
        expect(error).toHaveBeenCalledTimes(1);
        expect(String(error.mock.calls[0]![0])).toMatch(/SET_PAGE was NOT sent.*max 48 chars/);
    });

    it('reports each distinct reason once, not once per render', () => {
        const bad = page({ actions: [{ ...save, id: 'save it!' }] });
        publishPageChrome(bad, null, sink);
        publishPageChrome(bad, null, sink);
        publishPageChrome(bad, null, sink);
        expect(error).toHaveBeenCalledTimes(1);

        publishPageChrome(page({ dirty: 'yes' as unknown as boolean }), null, sink);
        expect(error).toHaveBeenCalledTimes(2);
    });

    it('keeps the last good payload as the diff base after a failure', () => {
        const good = publishPageChrome(page(), null, sink);
        expect(sink.setPage).toHaveBeenCalledTimes(1);

        const afterBad = publishPageChrome(page({ crumbs: new Array(6).fill({ label: 'c' }) }), good, sink);
        expect(afterBad).toBe(good);

        publishPageChrome(page(), afterBad, sink);
        expect(sink.setPage).toHaveBeenCalledTimes(1);
    });
});

describe('publishPageChrome — dirty and action state re-post', () => {
    it('posts once, dedupes an identical render, and re-posts when dirty flips', () => {
        let last = publishPageChrome(page(), null, sink);
        last = publishPageChrome(page(), last, sink);
        expect(sink.setPage).toHaveBeenCalledTimes(1);

        last = publishPageChrome(page({ dirty: true, actions: [{ ...save, disabled: false }, cancel] }), last, sink);
        expect(sink.setPage).toHaveBeenCalledTimes(2);
        expect(sink.setPage.mock.calls[1]![0]).toMatchObject({ dirty: true, actions: [{ id: 'submit', disabled: false }, { id: 'cancel' }] });

        last = publishPageChrome(page({ dirty: false, actions: [{ ...save, disabled: false }, cancel] }), last, sink);
        expect(sink.setPage).toHaveBeenCalledTimes(3);
    });

    it('re-posts when only an action disabled/loading flag changes', () => {
        let last = publishPageChrome(page({ dirty: true }), null, sink);
        last = publishPageChrome(page({ dirty: true, actions: [{ ...save, disabled: false }, cancel] }), last, sink);
        last = publishPageChrome(page({ dirty: true, actions: [{ ...save, disabled: true, loading: true }, cancel] }), last, sink);
        expect(sink.setPage).toHaveBeenCalledTimes(3);
        expect(sink.setPage.mock.calls[2]![0].actions[0]).toMatchObject({ disabled: true, loading: true });
    });
});
