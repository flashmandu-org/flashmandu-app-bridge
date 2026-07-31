import { describe, expect, it } from 'vitest';

import {
    buildAppUrl,
    buildPathChangePayload,
    globalParamsOf,
    isGlobalParam,
    normaliseAppPath,
} from '../url-state.js';

/**
 * The "globalness" rule: which parts of an embedded app's URL are reflected
 * into the HOST address bar. Decided once here for every app — these tests pin
 * the two failure modes that matter: leaking a credential outward, and
 * silently dropping view state a user expected to share.
 */
describe('isGlobalParam', () => {
    it('never lets transport plumbing reach the host URL', () => {
        // session_token is a live credential; the rest are wiring.
        for (const key of [
            'session_token',
            'parent_origin',
            'app_id',
            'profile_id',
            'installed_app_id',
            'instance_id',
            'locale',
            'target',
            'embed',
            'path',
        ]) {
            expect(isGlobalParam(key), `${key} must not be global`).toBe(false);
        }
    });

    it('treats ordinary app params as global by default', () => {
        for (const key of ['q', 'status', 'page', 'sort', 'tag', 'from', 'to']) {
            expect(isGlobalParam(key), `${key} should be global`).toBe(true);
        }
    });

    it('excludes underscore-prefixed ephemeral params', () => {
        expect(isGlobalParam('_modal')).toBe(false);
        expect(isGlobalParam('_tab')).toBe(false);
    });

    it('ignores empty keys', () => {
        expect(isGlobalParam('')).toBe(false);
    });
});

describe('globalParamsOf', () => {
    it('keeps app state and strips plumbing from a real embed URL', () => {
        const pairs = globalParamsOf(
            '?session_token=secret.sig&app_id=acme%2Fmaps&q=kathmandu&status=draft&_modal=open',
        );

        expect(pairs).toEqual([
            ['q', 'kathmandu'],
            ['status', 'draft'],
        ]);
    });

    it('preserves repeated keys so multi-select filters survive', () => {
        expect(globalParamsOf('?tag=a&tag=b')).toEqual([
            ['tag', 'a'],
            ['tag', 'b'],
        ]);
    });

    it('handles an empty search string', () => {
        expect(globalParamsOf('')).toEqual([]);
    });
});

describe('normaliseAppPath', () => {
    it('guarantees a leading slash and drops a trailing one', () => {
        expect(normaliseAppPath('maps')).toBe('/maps');
        expect(normaliseAppPath('/maps/')).toBe('/maps');
        expect(normaliseAppPath('')).toBe('/');
        expect(normaliseAppPath('/')).toBe('/');
    });

    it('refuses to pass an absolute URL through as a path', () => {
        // Guards against an app posting a full URL and the host reflecting a
        // foreign origin into its own address bar.
        expect(normaliseAppPath('https://evil.test/steal')).toBe('/steal');
        expect(normaliseAppPath('https://evil.test')).toBe('/');
    });

    it('separates query and hash from the path', () => {
        expect(normaliseAppPath('/maps?q=1')).toBe('/maps');
        expect(normaliseAppPath('/maps#top')).toBe('/maps');
    });
});

describe('buildPathChangePayload', () => {
    it('carries the page and its shareable state, nothing else', () => {
        expect(
            buildPathChangePayload('/maps/', '?q=kath&session_token=secret&_x=1'),
        ).toEqual({
            path: '/maps',
            query: [['q', 'kath']],
        });
    });
});

describe('buildAppUrl', () => {
    it('round-trips a path plus its params', () => {
        expect(buildAppUrl('/maps', [['q', 'kath'], ['status', 'draft']]))
            .toBe('/maps?q=kath&status=draft');
    });

    it('drops non-global params handed back by the host', () => {
        // Defence in depth: even if the host stored something it should not
        // have, the app does not restore plumbing into its own URL.
        const fromHost: Array<[string, string]> = [
            ['session_token', 'secret'],
            ['q', 'kath'],
        ];
        expect(buildAppUrl('/maps', fromHost)).toBe('/maps?q=kath');
    });

    it('returns a bare path when there is no query', () => {
        expect(buildAppUrl('/maps', [])).toBe('/maps');
        expect(buildAppUrl('/maps', undefined)).toBe('/maps');
    });
});
