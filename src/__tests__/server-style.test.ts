import { describe, expect, it } from 'vitest';

import { mintEmbedToken, verifyEmbedTokenDetailed } from '../server/auth.js';
import { decodeStyleSurfaceClaim, styleSurfaceCss } from '../server/style.js';

const SECRET = 'appsecret';

/** Pack a var map the way the platform packs the `style` claim: base64url(JSON). */
function packStyleClaim(vars: Record<string, string>): string {
    return Buffer.from(JSON.stringify(vars), 'utf8').toString('base64url');
}

describe('styleSurfaceCss', () => {
    it('returns an empty string for an install with no customisation — byte-identical to before this feature existed', () => {
        expect(styleSurfaceCss({})).toBe('');
        expect(styleSurfaceCss(null)).toBe('');
        expect(styleSurfaceCss(undefined)).toBe('');
        expect(styleSurfaceCss({ profile_id: '1' })).toBe('');
    });

    it('renders a single slot as :root{--x:y}', () => {
        const payload = { style: packStyleClaim({ '--tours-card-bg': '#ffffff' }) };
        expect(styleSurfaceCss(payload)).toBe(':root{--tours-card-bg:#ffffff}');
    });

    it('renders multiple slots, keys sorted for deterministic output', () => {
        const payload = {
            style: packStyleClaim({
                '--tours-card-radius': '12px',
                '--tours-card-bg': '#ffffff',
                '--tours-card-shadow': '0 1px 2px rgba(0,0,0,.1)',
            }),
        };
        expect(styleSurfaceCss(payload)).toBe(
            ':root{--tours-card-bg:#ffffff;--tours-card-radius:12px;--tours-card-shadow:0 1px 2px rgba(0,0,0,.1)}',
        );
    });

    it('round-trips through a real signed embed token', () => {
        const token = mintEmbedToken(
            { profile_id: '9', style: packStyleClaim({ '--tours-card-bg': '#161616' }) },
            SECRET,
        );
        const verified = verifyEmbedTokenDetailed(token, SECRET);
        expect(verified.ok).toBe(true);
        expect(verified.ok && styleSurfaceCss(verified.payload)).toBe(':root{--tours-card-bg:#161616}');
    });

    it('is empty for malformed base64url', () => {
        expect(styleSurfaceCss({ style: '!!!not-base64!!!' })).toBe('');
    });

    it('is empty for base64url that decodes to non-JSON', () => {
        const notJson = Buffer.from('not json', 'utf8').toString('base64url');
        expect(styleSurfaceCss({ style: notJson })).toBe('');
    });

    it('is empty when the decoded JSON is an array or a scalar, not an object', () => {
        expect(styleSurfaceCss({ style: Buffer.from('[1,2,3]', 'utf8').toString('base64url') })).toBe('');
        expect(styleSurfaceCss({ style: Buffer.from('"just a string"', 'utf8').toString('base64url') })).toBe('');
    });

    it('drops a key that is not a valid CSS custom-property name', () => {
        const payload = { style: packStyleClaim({ 'not-a-var': 'red', '--ok': 'blue' }) };
        expect(styleSurfaceCss(payload)).toBe(':root{--ok:blue}');
    });

    it('drops a non-string value rather than stamping it', () => {
        const payload = { style: Buffer.from(JSON.stringify({ '--x': 12, '--y': 'green' }), 'utf8').toString('base64url') };
        expect(styleSurfaceCss(payload)).toBe(':root{--y:green}');
    });

    it('drops a value that could break out of its declaration (defence in depth against a signing-key compromise)', () => {
        const payload = { style: packStyleClaim({ '--safe': 'blue', '--evil': 'red;} body{display:none' }) };
        expect(styleSurfaceCss(payload)).toBe(':root{--safe:blue}');
    });

    it('drops an oversized value', () => {
        const payload = { style: packStyleClaim({ '--huge': 'x'.repeat(600) }) };
        expect(styleSurfaceCss(payload)).toBe('');
    });
});

describe('decodeStyleSurfaceClaim', () => {
    it('returns the raw map, for a caller that wants values rather than CSS text', () => {
        const payload = { style: packStyleClaim({ '--a': '1px', '--b': 'red' }) };
        expect(decodeStyleSurfaceClaim(payload)).toEqual({ '--a': '1px', '--b': 'red' });
    });

    it('returns an empty object rather than throwing on any malformed input', () => {
        expect(decodeStyleSurfaceClaim({})).toEqual({});
        expect(decodeStyleSurfaceClaim(null)).toEqual({});
        expect(decodeStyleSurfaceClaim({ style: 'garbage' })).toEqual({});
    });
});
