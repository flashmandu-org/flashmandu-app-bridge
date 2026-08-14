/**
 * Colour-scheme plumbing — framework-free, DOM-only, no React.
 *
 * WHY THIS EXISTS
 * ---------------
 * An embedded app cannot work out the merchant's theme on its own. Inside an
 * iframe, `prefers-color-scheme` reports the OS setting of whoever is looking
 * at the screen, which is right for a standalone site and wrong for an embed:
 * a merchant on a light admin with a dark OS got a dark app inside a light
 * page. The host is the only party that knows the answer, so it has to say it.
 *
 * FOUR DELIVERY POINTS, IN DESCENDING ORDER OF EARLINESS
 * --------------------------------------------------------
 *  1. The embed URL fragment (`#fm_theme=dark`) — readable SYNCHRONOUSLY, in
 *     an inline script, before the document paints. This is the only channel
 *     early enough to prevent a flash of the wrong theme; the other two are
 *     both strictly after the app's JS has booted.
 *
 *     A FRAGMENT and not a query parameter, on purpose. The host HMAC-signs the
 *     embed query string (`sig`), and the theme is a client-side value the host
 *     server does not know at render time — appending an unsigned query param
 *     would break every app that verifies the signature. A fragment is not part
 *     of the signed query, is never sent to the app's server, and costs the
 *     signature nothing.
 *
 *  2. `CONTEXT.theme` — the handshake reply. Confirms the fragment (or supplies
 *     the value when the app was opened without one).
 *
 *  3. The `THEME` message — every later change, so a merchant toggling their
 *     admin theme is followed live, without reloading the iframe.
 *
 *  4. `light` — the LAST-RESORT fallback, used only when 1–3 all say nothing.
 *     The host's own embed shell ALWAYS appends the fragment, so this branch
 *     never fires inside a real embed; it only fires when the app is run
 *     standalone (`npm run dev`, a preview deploy with no host). Because it
 *     only ever affects developers, it defaults to `light` — the product is
 *     light-first — rather than `prefers-color-scheme`, which used to hand a
 *     dark-OS developer a dark app and get "fixed" by hardcoding dark styles
 *     that then shipped to every merchant. A standalone app that DOES want to
 *     track the OS opts back in explicitly with `data-fm-theme-follow-system`
 *     on `<html>`; see {@link THEME_FOLLOW_SYSTEM_ATTRIBUTE}.
 *
 * WHAT GETS STAMPED ON THE DOCUMENT
 * ---------------------------------
 * Both `data-fm-theme="dark"` (the Bridge UI token contract) and the `dark`
 * class (what the HOST platform itself puts on `<html>`, and what Tailwind's
 * class dark-mode strategy looks for). Writing both means an app styled with
 * Bridge UI tokens and an app styled with Tailwind both follow the merchant
 * with no adapter code, and the host and the app stay legible to each other.
 */

import type { ColorScheme } from './types.js';

/** Fragment key carrying the initial scheme on the embed URL. */
export const THEME_FRAGMENT_KEY = 'fm_theme';

/** Attribute the Bridge UI token layer keys its dark tokens off. */
export const THEME_ATTRIBUTE = 'data-fm-theme';

/** Class name mirroring the host platform's own dark-mode switch. */
export const THEME_CLASS = 'dark';

/**
 * Opt-in attribute for a STANDALONE app that wants the pre-fragment fallback
 * to track `prefers-color-scheme` instead of defaulting to `light`. Set it on
 * `<html>` (e.g. hardcoded in the shell, or via a dev-only build flag) —
 * never as the app's normal posture, since every real embed already gets its
 * theme from the fragment and never reaches this fallback at all.
 */
export const THEME_FOLLOW_SYSTEM_ATTRIBUTE = 'data-fm-theme-follow-system';

/**
 * Coerce anything to a valid scheme, or null.
 *
 * `null` rather than a `'light'` default is the whole point: the caller has to
 * decide whether "not declared" means light or means "keep following the OS",
 * and those are different answers in different places.
 */
export function normaliseColorScheme(value: unknown): ColorScheme | null {
    return value === 'dark' || value === 'light' ? value : null;
}

/**
 * Pull the scheme out of a URL's fragment (preferred) or query string.
 *
 * The fragment is matched with a regex rather than parsed as a query string
 * because an app is free to keep its own router state in the hash: the value
 * may sit at `#fm_theme=dark`, `#/reports?fm_theme=dark`, or anywhere between.
 */
export function readThemeFromUrl(url: { hash?: string; search?: string } | null | undefined): ColorScheme | null {
    if (url === null || url === undefined) {
        return null;
    }

    const hash = typeof url.hash === 'string' ? url.hash : '';
    const match = new RegExp(`[#&?]${THEME_FRAGMENT_KEY}=([^&]+)`).exec(hash);
    const fromHash = match === null || match[1] === undefined
        ? null
        : normaliseColorScheme(decodeURIComponent(match[1]));
    if (fromHash !== null) {
        return fromHash;
    }

    // Query fallback: a host that CAN sign the value (or one framing an app
    // that does not verify `sig` at all) may prefer to put it in the query,
    // where the app's server can see it and server-render the right theme.
    const search = typeof url.search === 'string' ? url.search : '';
    if (search === '') {
        return null;
    }

    try {
        return normaliseColorScheme(new URLSearchParams(search).get(THEME_FRAGMENT_KEY));
    } catch {
        return null;
    }
}

/** What the viewer's OS says. Only consulted when {@link followsSystemTheme} allows it. */
export function prefersDarkColorScheme(view: { matchMedia?: (q: string) => { matches: boolean } } | null | undefined): boolean {
    if (view === null || view === undefined || typeof view.matchMedia !== 'function') {
        return false;
    }

    try {
        return view.matchMedia('(prefers-color-scheme: dark)').matches === true;
    } catch {
        return false;
    }
}

/**
 * Whether `<html>` carries the explicit standalone-dev opt-in. Everywhere
 * else — every real embed, and a standalone app that never sets it — this is
 * `false`, and the fallback is `light`.
 */
function followsSystemTheme(doc: { documentElement?: { hasAttribute?: (name: string) => boolean } } | null | undefined): boolean {
    return doc?.documentElement?.hasAttribute?.(THEME_FOLLOW_SYSTEM_ATTRIBUTE) === true;
}

/**
 * The OS fallback, gated on the opt-in attribute. `light` unless `<html>`
 * carries `data-fm-theme-follow-system` AND the OS says dark.
 */
function osFallbackColorScheme(
    view: { matchMedia?: (q: string) => { matches: boolean } } | null | undefined,
    doc: { documentElement?: { hasAttribute?: (name: string) => boolean } } | null | undefined,
): ColorScheme {
    return followsSystemTheme(doc) && prefersDarkColorScheme(view) ? 'dark' : 'light';
}

/**
 * The scheme to paint with before the bridge handshake has happened.
 *
 * Embed URL first, then the gated OS fallback. Returns a concrete value so a
 * caller never has to invent one. The host always sends the fragment, so the
 * fallback branch below only ever runs for a standalone (non-embedded) app —
 * see the module doc comment for why it defaults to `light` there.
 */
export function resolveInitialColorScheme(view: (Window & typeof globalThis) | null | undefined = typeof window === 'undefined' ? null : window): ColorScheme {
    if (view === null || view === undefined) {
        return 'light';
    }

    const fromUrl = readThemeFromUrl(view.location);
    if (fromUrl !== null) {
        return fromUrl;
    }

    const doc = (view as unknown as { document?: Document }).document
        ?? (typeof document === 'undefined' ? null : document);

    return osFallbackColorScheme(view, doc);
}

/**
 * Stamp the scheme onto the document element.
 *
 * `color-scheme` goes on too: without it the browser keeps painting form
 * controls, scrollbars and the canvas behind the page in light, which is the
 * one bit of "dark mode" no amount of custom properties can reach.
 */
export function applyColorScheme(scheme: ColorScheme, doc: Document | null | undefined = typeof document === 'undefined' ? null : document): void {
    const root = doc?.documentElement;
    if (root === null || root === undefined) {
        return;
    }

    root.setAttribute(THEME_ATTRIBUTE, scheme);
    root.classList.toggle(THEME_CLASS, scheme === 'dark');
    root.style.colorScheme = scheme;
}

/**
 * The pre-paint bootstrap, as source text to inline in a `<script>`.
 *
 * Any app that renders HTML from a server (Next.js, Nuxt, Blade, a static
 * file) should emit this INSIDE the document, ahead of its own content. It
 * runs during HTML parsing — before the first paint — so the app's very first
 * frame is already in the merchant's theme. Deferring this to a normal module,
 * an effect or the bridge handshake all produce the same visible artefact: one
 * frame of the wrong theme.
 *
 * Kept deliberately tiny and dependency-free; it is duplicated logic rather
 * than a call into this module because at the time it runs no module has
 * loaded yet.
 */
export function themeBootstrapScript(): string {
    return `(function(){try{`
        + `var m=/[#&?]${THEME_FRAGMENT_KEY}=([^&]+)/.exec(location.hash)`
        + `||/[?&]${THEME_FRAGMENT_KEY}=([^&]+)/.exec(location.search);`
        + `var r=document.documentElement;`
        + `var t=m&&(m[1]==='dark'||m[1]==='light')?m[1]`
        + `:(r.hasAttribute('${THEME_FOLLOW_SYSTEM_ATTRIBUTE}')&&window.matchMedia&&window.matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light');`
        + `r.setAttribute('${THEME_ATTRIBUTE}',t);`
        + `r.classList.toggle('${THEME_CLASS}',t==='dark');`
        + `r.style.colorScheme=t;`
        + `}catch(e){}})();`;
}
