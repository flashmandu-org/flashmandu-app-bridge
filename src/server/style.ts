/**
 * Style Surface SSR inlining — the storefront's zero-FOUC delivery channel
 * (design doc §3.3(ii)).
 *
 * WHY THIS LIVES HERE AND NOT IN `style.ts`
 * ------------------------------------------
 * The storefront embed is `sandbox="allow-scripts"` with no
 * `allow-same-origin` — an opaque origin — so it has no `localStorage` and the
 * client-side bootstrap in `style.ts` cannot help it. The platform already
 * server-renders the embed page (Tours' `route.ts`), so the cheapest correct
 * fix is to hand the app the resolved token map BEFORE it renders: no extra
 * request, no CORS, no FOUC. This is that hand-off, expressed as one pure
 * function so an app author's whole obligation is
 * `styleSurfaceCss(verified.payload)` ahead of their own viewer stylesheet —
 * the exact spot `tours/lib/themes.ts` hand-rolled before this package
 * existed.
 *
 * THE `style` CLAIM
 * ------------------
 * `verifyEmbedTokenDetailed()` (see `auth.ts`) returns a flat `Record<string,
 * string>` — every embed/session token claim is a scalar, by construction of
 * the signing scheme. The platform packs the resolved Style Surface map into
 * ONE scalar claim, `style`: base64url of the compact JSON
 * `{"--tours-card-bg":"#fff",…}`, capped at 1024 bytes by the platform before
 * signing. This function is the inverse of that packing — decode, then emit.
 *
 * It deliberately does NOT fetch `style_url` (the platform's fallback for a
 * map that exceeded the cap): that would turn a synchronous, dependency-free
 * render helper into an async network call on every request, defeating the
 * entire "no extra request" point of this channel. An app whose surface count
 * is large enough to need `style_url` reads it directly from
 * `verified.payload.style_url` and fetches it itself, on its own cache policy.
 */

/** The scalar claim carrying the packed token map. See module doc above. */
const STYLE_CLAIM_KEY = 'style';

/** base64url decode tolerant of missing padding, mirroring `auth.ts`. */
function base64urlDecode(input: string): string {
    const pad = input.length % 4 === 0 ? '' : '='.repeat(4 - (input.length % 4));
    return Buffer.from(input + pad, 'base64url').toString('utf8');
}

/** Only accept keys shaped like a CSS custom-property name. */
function isCustomPropertyName(name: string): boolean {
    return /^--[a-zA-Z0-9-]+$/.test(name);
}

/**
 * A CSS value is emitted verbatim into a `<style>` block, so a value carrying
 * `;`, `{`, `}`, `<`, or a newline could break out of its declaration or the
 * element entirely. The platform validates every value at WRITE time (design
 * §3.7) and this render path trusts an HMAC-verified claim — but a second,
 * cheap gate here costs nothing and means a bug or a future signing-key
 * compromise degrades to "this one slot is dropped", never markup injection.
 */
function isSafeCssValue(value: string): boolean {
    return value.length > 0 && value.length <= 512 && !/[;{}<>\n\r]/.test(value);
}

/**
 * Decode the `style` claim out of a verified embed-token payload into a flat
 * CSS-custom-property map. Returns an empty object for a missing, malformed,
 * or empty claim — never throws. Exported separately from
 * {@link styleSurfaceCss} so a caller that wants the map itself (e.g. to feed
 * a canvas renderer server-side) does not have to round-trip through CSS text.
 */
export function decodeStyleSurfaceClaim(payload: Record<string, string> | null | undefined): Record<string, string> {
    const claim = payload?.[STYLE_CLAIM_KEY];
    if (typeof claim !== 'string' || claim === '') {
        return {};
    }

    let parsed: unknown;
    try {
        parsed = JSON.parse(base64urlDecode(claim));
    } catch {
        return {};
    }

    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        return {};
    }

    const vars: Record<string, string> = {};
    for (const [name, value] of Object.entries(parsed as Record<string, unknown>)) {
        if (isCustomPropertyName(name) && typeof value === 'string' && isSafeCssValue(value)) {
            vars[name] = value;
        }
    }
    return vars;
}

/**
 * Render a verified embed-token payload's Style Surface claim as an inlined
 * `<style>`-ready CSS string: `:root{--tours-card-bg:#fff;…}`.
 *
 * Returns `''` — not `':root{}'`, not a comment, nothing — when the install
 * has no customisation at all, so an untouched app install's rendered HTML is
 * BYTE-IDENTICAL to before this feature existed. Keys are sorted for
 * deterministic output (stable across renders and diffable in tests/snapshots).
 *
 * Usage (SSR route, ahead of the app's own viewer stylesheet):
 *
 * ```ts
 * import { verifyEmbedTokenDetailed } from '@flashmandu/app-bridge/server';
 * import { styleSurfaceCss } from '@flashmandu/app-bridge/server';
 *
 * const verified = verifyEmbedTokenDetailed(token, secret);
 * const css = verified.ok ? styleSurfaceCss(verified.payload) : '';
 * // <style>{css}</style>  — before the viewer's own <link rel="stylesheet">
 * ```
 */
export function styleSurfaceCss(payload: Record<string, string> | null | undefined): string {
    const vars = decodeStyleSurfaceClaim(payload);
    const names = Object.keys(vars).sort();
    if (names.length === 0) {
        return '';
    }

    const declarations = names.map((name) => `${name}:${vars[name]}`).join(';');
    return `:root{${declarations}}`;
}
