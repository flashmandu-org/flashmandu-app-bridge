/**
 * Style Surface plumbing — framework-free, DOM-only, no React.
 *
 * Modelled module-for-module on `theme.ts`: this is the same host→iframe
 * delivery problem (a merchant-controlled visual property the app cannot know
 * on its own) solved with the same shape — an early URL signal for the
 * pre-paint bootstrap, a live postMessage for in-session edits, and a plain
 * DOM-writing function both funnel into.
 *
 * WHAT A "STYLE SURFACE" IS
 * -------------------------
 * A named region of an app's UI (a card, a pin, a panel) whose visual
 * properties the platform's page builder lets a merchant restyle, the same way
 * it restyles a native composable element. The app declares typed slots in its
 * manifest and reads `var(--x, <default>)`; the platform resolves the
 * merchant's edits into a flat CSS-custom-property map and delivers it here.
 * The app never sees the builder UI, the validation, or the storage — only the
 * resolved `{ "--tours-card-bg": "#ffffff", ... }` map.
 *
 * THE ADMIN/STOREFRONT ASYMMETRY — READ BEFORE TOUCHING THIS FILE
 * -----------------------------------------------------------------
 * The admin iframe (builder preview, Installed Apps → Appearance) is served
 * with `allow-same-origin`, so `localStorage` works there and
 * {@link styleBootstrapScript} can cache the resolved map across loads for a
 * zero-FOUC repaint. The STOREFRONT embed is `sandbox="allow-scripts"` with NO
 * `allow-same-origin` — an opaque origin — so `localStorage` is not merely
 * empty there, *reading the property itself throws*. This module never assumes
 * storage exists: every touch point is wrapped so a storefront app gets a
 * clean, silent no-op and falls through to its own shipped defaults. The
 * storefront's actual zero-FOUC path is server-side inlining
 * ({@link ../server/style.js!styleSurfaceCss}) ahead of the viewer stylesheet
 * — never this bootstrap.
 *
 * DELIVERY POINTS THIS MODULE SERVES (design doc §3.3)
 * ------------------------------------------------------
 *  (i)   Builder live preview — a `STYLE_TOKENS` postMessage while the
 *        merchant drags a control. Applied instantly by `createAppBridge()`
 *        via {@link applyStyleTokens}; see `app-bridge.ts`.
 *  (ii)  Storefront production — resolved server-side by
 *        `styleSurfaceCss()` in `server/style.ts`, inlined ahead of the
 *        viewer's own stylesheet. This module is not involved.
 *  (iii) Admin embed production — the fragment key here
 *        ({@link STYLE_REV_FRAGMENT_KEY}) read synchronously by
 *        {@link styleBootstrapScript}, backed by a `localStorage` cache
 *        written by `createAppBridge()` whenever a fresher map arrives
 *        (CONTEXT or a live STYLE_TOKENS push). `CONTEXT.styleTokens` lands
 *        one tick later and repaints anything the cache missed.
 */

/** Fragment key carrying the style-surface revision on the embed URL. */
export const STYLE_REV_FRAGMENT_KEY = 'fm_style_rev';

/** `localStorage` key the pre-paint bootstrap and the bridge share. */
export const STYLE_CACHE_STORAGE_KEY = 'fm:style:cache';

/** A revision is an opaque short id — never trusted as anything else. */
function normaliseStyleRev(value: unknown): string | null {
    return typeof value === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(value) ? value : null;
}

/**
 * Pull the style revision out of a URL's fragment (preferred) or query string.
 *
 * Mirrors `readThemeFromUrl` exactly, including WHY a regex and not a parsed
 * query string: an app is free to keep its own router state in the hash.
 */
export function readStyleRevFromUrl(url: { hash?: string; search?: string } | null | undefined): string | null {
    if (url === null || url === undefined) {
        return null;
    }

    const hash = typeof url.hash === 'string' ? url.hash : '';
    const match = new RegExp(`[#&?]${STYLE_REV_FRAGMENT_KEY}=([^&]+)`).exec(hash);
    const fromHash = match === null || match[1] === undefined
        ? null
        : normaliseStyleRev(decodeURIComponent(match[1]));
    if (fromHash !== null) {
        return fromHash;
    }

    const search = typeof url.search === 'string' ? url.search : '';
    if (search === '') {
        return null;
    }

    try {
        return normaliseStyleRev(new URLSearchParams(search).get(STYLE_REV_FRAGMENT_KEY));
    } catch {
        return null;
    }
}

/**
 * Only accept values shaped like CSS custom-property assignments. Guards
 * against a malformed or hostile payload writing an arbitrary property name,
 * and against a non-string value tripping `CSSStyleDeclaration.setProperty`.
 */
function isCustomPropertyEntry(name: unknown, value: unknown): name is string {
    return typeof name === 'string' && name.startsWith('--') && typeof value === 'string';
}

/**
 * Apply a resolved Style Surface token map to the document root.
 *
 * `root.style.setProperty` per entry — a paint, no reload, no re-mint. Safe to
 * call with a partial map (a live builder edit to one slot): unlisted
 * properties are left exactly as they were, which is what lets a merchant drag
 * a single slider without every other slot flashing back to its default.
 *
 * No-ops without a document (SSR) or with a malformed map, matching
 * `applyColorScheme`'s SSR safety.
 */
export function applyStyleTokens(vars: Record<string, string> | null | undefined, doc: Document | null | undefined = typeof document === 'undefined' ? null : document): void {
    const root = doc?.documentElement;
    if (root === null || root === undefined || vars === null || vars === undefined || typeof vars !== 'object') {
        return;
    }

    for (const [name, value] of Object.entries(vars)) {
        if (isCustomPropertyEntry(name, value)) {
            root.style.setProperty(name, value);
        }
    }
}

/**
 * Cache a resolved token map in `localStorage`, keyed by its revision, for the
 * next load's pre-paint bootstrap to find.
 *
 * Every touch of `localStorage` is inside the `try`: in the storefront's
 * opaque-origin sandbox, reading `window.localStorage` itself throws, not just
 * `setItem`. A caller that never passes `storage` explicitly (the normal case,
 * from `createAppBridge()`) gets a silent no-op there — which is correct,
 * because the storefront never runs this bridge at all; it consumes
 * `styleSurfaceCss()` server-side instead. This function exists for the admin
 * embed, where `allow-same-origin` makes `localStorage` real.
 */
export function cacheStyleTokens(
    rev: string | null | undefined,
    vars: Record<string, string>,
    storage?: Storage | null,
): void {
    if (typeof rev !== 'string' || rev === '') {
        return;
    }

    try {
        const target = storage !== undefined
            ? storage
            : (typeof window === 'undefined' ? null : window.localStorage);
        if (target === null || target === undefined) {
            return;
        }
        target.setItem(STYLE_CACHE_STORAGE_KEY, JSON.stringify({ rev, vars }));
    } catch {
        // Sandboxed iframe (no allow-same-origin), storage disabled, or quota
        // exceeded. Silent no-op — the app just repaints from CONTEXT instead.
    }
}

/**
 * The pre-paint bootstrap, as source text to inline in a `<script>`.
 *
 * Any app that renders HTML from a server (Next.js, Nuxt, Blade, a static
 * file) should emit this INSIDE the document, ahead of its own content,
 * alongside `themeBootstrapScript()`. It reads the revision from the embed URL
 * fragment synchronously — before the first paint — and, ONLY if a
 * `localStorage` cache exists for that exact revision, repaints the root with
 * it. Any miss (no fragment, no cache, mismatched revision, or a sandboxed
 * frame where `localStorage` throws) is a silent no-op: the app's own shipped
 * CSS defaults stand until `CONTEXT.styleTokens` or a `STYLE_TOKENS` push
 * lands, exactly as an un-customised install should look.
 *
 * Dependency-free by construction: at the point this runs, no module — this
 * one included — has loaded yet.
 */
export function styleBootstrapScript(): string {
    return `(function(){try{`
        + `var m=/[#&?]${STYLE_REV_FRAGMENT_KEY}=([^&]+)/.exec(location.hash)`
        + `||/[?&]${STYLE_REV_FRAGMENT_KEY}=([^&]+)/.exec(location.search);`
        + `var rev=m&&/^[A-Za-z0-9_-]{1,64}$/.test(m[1])?m[1]:null;`
        + `if(!rev)return;`
        + `var raw=window.localStorage&&window.localStorage.getItem('${STYLE_CACHE_STORAGE_KEY}');`
        + `if(!raw)return;`
        + `var cached=JSON.parse(raw);`
        + `if(!cached||cached.rev!==rev||!cached.vars)return;`
        + `var r=document.documentElement;`
        + `for(var k in cached.vars){`
        + `if(Object.prototype.hasOwnProperty.call(cached.vars,k)&&k.indexOf('--')===0&&typeof cached.vars[k]==='string'){`
        + `r.style.setProperty(k,cached.vars[k]);`
        + `}}`
        + `}catch(e){}})();`;
}
