import { describe, expect, it } from 'vitest';

import {
    BridgeValidationError,
    normalisePageChrome,
    PAGE_ACTION_ICONS,
    pageChromeEquals,
} from '../page-chrome.js';
import type { SetPagePayload } from '../types.js';

/**
 * SET_PAGE caps are enforced by the HOST as a silent whole-payload drop, so the
 * only feedback an app author gets from a bad payload is "my breadcrumbs
 * vanished". These tests pin the client-side mirror of every cap — the thing
 * that turns that silence into a stack trace.
 */

const base: SetPagePayload = { crumbs: [], actions: [], dirty: false };

const crumbs = (n: number) => Array.from({ length: n }, (_, i) => ({ label: `c${i}` }));
const actions = (n: number) =>
    Array.from({ length: n }, (_, i) => ({ id: `a${i}`, label: `A${i}`, variant: 'ghost' as const }));

describe('normalisePageChrome caps', () => {
    it('accepts the maximum allowed crumbs and actions', () => {
        const out = normalisePageChrome({ ...base, crumbs: crumbs(5), actions: actions(4) });
        expect(out.crumbs).toHaveLength(5);
        expect(out.actions).toHaveLength(4);
    });

    it('rejects a sixth crumb', () => {
        expect(() => normalisePageChrome({ ...base, crumbs: crumbs(6) })).toThrow(BridgeValidationError);
    });

    it('rejects a fifth action', () => {
        expect(() => normalisePageChrome({ ...base, actions: actions(5) })).toThrow(BridgeValidationError);
    });

    it('rejects a label over 48 chars', () => {
        expect(() =>
            normalisePageChrome({ ...base, crumbs: [{ label: 'x'.repeat(49) }] }),
        ).toThrow(/max 48 chars/);
    });

    it('rejects an action id outside [A-Za-z0-9_-]{1,32}', () => {
        expect(() =>
            normalisePageChrome({ ...base, actions: [{ id: 'save it!', label: 'Save', variant: 'primary' }] }),
        ).toThrow(BridgeValidationError);
        expect(() =>
            normalisePageChrome({ ...base, actions: [{ id: 'a'.repeat(33), label: 'Save', variant: 'primary' }] }),
        ).toThrow(BridgeValidationError);
    });

    it('rejects an unknown variant', () => {
        expect(() =>
            normalisePageChrome({
                ...base,
                actions: [{ id: 'save', label: 'Save', variant: 'secondary' as never }],
            }),
        ).toThrow(/variant/);
    });

    it('rejects duplicate action ids, which ACTION could not route', () => {
        expect(() =>
            normalisePageChrome({
                ...base,
                actions: [
                    { id: 'save', label: 'Save', variant: 'primary' },
                    { id: 'save', label: 'Save as', variant: 'ghost' },
                ],
            }),
        ).toThrow(/duplicate action id/);
    });

    it.each([
        ['protocol-relative', '//evil.example'],
        ['absolute', 'https://evil.example'],
        ['relative', 'maps'],
        ['a query string', '/maps?q=1'],
        ['a fragment', '/maps#top'],
        ['dot segments', '/maps/../admin'],
        ['percent-encoding', '/maps%2Fadmin'],
    ])('rejects a crumb path with %s', (_why, path) => {
        expect(() => normalisePageChrome({ ...base, crumbs: [{ label: 'X', path }] })).toThrow(
            BridgeValidationError,
        );
    });

    it('accepts the host APP_PATH_PATTERN shape', () => {
        const out = normalisePageChrome({
            ...base,
            crumbs: [{ label: 'X', path: '/maps/kathmandu_9-a/' }],
        });
        expect(out.crumbs[0]?.path).toBe('/maps/kathmandu_9-a/');
    });

    it('rejects a crumb path over 200 chars', () => {
        expect(() =>
            normalisePageChrome({ ...base, crumbs: [{ label: 'X', path: `/${'a'.repeat(200)}` }] }),
        ).toThrow(BridgeValidationError);
    });

    it('never silently truncates — an over-cap label throws instead of shortening', () => {
        const long = 'x'.repeat(60);
        expect(() => normalisePageChrome({ ...base, crumbs: [{ label: long }] })).toThrow();
    });

    it('drops undefined optionals so two equivalent payloads compare equal', () => {
        const out = normalisePageChrome({
            ...base,
            crumbs: [{ label: 'Maps', path: undefined }],
            actions: [{ id: 'save', label: 'Save', variant: 'primary', icon: undefined }],
        });
        expect(Object.keys(out.crumbs[0]!)).toEqual(['label']);
        expect(Object.keys(out.actions[0]!)).toEqual(['id', 'label', 'variant']);
        expect(out.title).toBeUndefined();
    });

    it('requires `dirty` to be a real boolean — the host drops the payload otherwise', () => {
        expect(() => normalisePageChrome({ ...base, dirty: 1 as never })).toThrow(/real boolean/);
        expect(() => normalisePageChrome({ crumbs: [], actions: [] } as never)).toThrow(/real boolean/);
        expect(normalisePageChrome({ ...base, dirty: true }).dirty).toBe(true);
    });

    it.each(['disabled', 'loading'])('requires %s to be a boolean when present', (field) => {
        expect(() =>
            normalisePageChrome({
                ...base,
                actions: [{ id: 'save', label: 'Save', variant: 'primary', [field]: 'yes' } as never],
            }),
        ).toThrow(new RegExp(`${field} must be a boolean`));
    });

    it('trims the title and measures the trimmed length, as the host does', () => {
        expect(normalisePageChrome({ ...base, title: '  Maps  ' }).title).toBe('Maps');
        expect(() => normalisePageChrome({ ...base, title: 'x'.repeat(121) })).toThrow(/after trim/);
        expect(normalisePageChrome({ ...base, title: `  ${'x'.repeat(120)}  ` }).title).toHaveLength(120);
    });

    it('passes an unknown icon through instead of rejecting, matching the host', () => {
        // The host renders an unknown icon as NO icon. Throwing here would make
        // the SDK stricter than the thing it is protecting the app from.
        const out = normalisePageChrome({
            ...base,
            actions: [{ id: 'save', label: 'Save', variant: 'primary', icon: 'sparkles' }],
        });
        expect(out.actions[0]?.icon).toBe('sparkles');
    });

    it('accepts every icon on the host allow-list', () => {
        for (const icon of PAGE_ACTION_ICONS) {
            const out = normalisePageChrome({
                ...base,
                actions: [{ id: 'a', label: 'A', variant: 'ghost', icon }],
            });
            expect(out.actions[0]?.icon).toBe(icon);
        }
    });
});

describe('pageChromeEquals', () => {
    const page = (over: Partial<SetPagePayload> = {}): SetPagePayload =>
        normalisePageChrome({
            title: 'Maps',
            crumbs: [{ label: 'Maps', path: '/maps' }, { label: 'Kathmandu' }],
            actions: [{ id: 'save', label: 'Save', variant: 'primary' }],
            dirty: false,
            ...over,
        });

    it('is true for two structurally identical payloads built separately', () => {
        expect(pageChromeEquals(page(), page())).toBe(true);
    });

    it('is insensitive to key order within a crumb', () => {
        const a = normalisePageChrome({ ...base, crumbs: [{ label: 'Maps', path: '/maps' }] });
        const b = normalisePageChrome({ ...base, crumbs: [{ path: '/maps', label: 'Maps' } as never] });
        expect(pageChromeEquals(a, b)).toBe(true);
    });

    it('notices a dirty flip', () => {
        expect(pageChromeEquals(page(), page({ dirty: true }))).toBe(false);
    });

    it('notices an action going into its loading state', () => {
        expect(
            pageChromeEquals(page(), page({ actions: [{ id: 'save', label: 'Save', variant: 'primary', loading: true }] })),
        ).toBe(false);
    });

    it('notices a title change', () => {
        expect(pageChromeEquals(page(), page({ title: 'Maps · Edit' }))).toBe(false);
    });

    it('treats null as equal only to null', () => {
        expect(pageChromeEquals(null, null)).toBe(true);
        expect(pageChromeEquals(null, page())).toBe(false);
    });
});
