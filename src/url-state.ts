/**
 * URL state: which parts of an embedded app's URL belong in the HOST's address
 * bar, and which are private to the iframe.
 *
 * Every embedded app faces the same problem. Its own URL carries two very
 * different kinds of thing mixed together:
 *
 *   1. Transport plumbing the platform injected — session_token, parent_origin,
 *      app_id, profile_id. Secrets and wiring. Must NEVER be echoed into the
 *      host's address bar, where they would be copy-pasted, logged by
 *      analytics, and land in browser history.
 *
 *   2. View state the merchant would reasonably expect to share or reload
 *      into — the current page, a search term, a status filter, a page number.
 *
 * Apps were being asked to make that call themselves, which meant every app
 * made it slightly differently (and interactive-map made it not at all — only
 * the pathname was synced, so filters silently vanished on reload). The
 * decision is not app-specific, so it lives here and applies automatically.
 *
 * THE RULE
 * --------
 * A query param is global — i.e. reflected into the host URL — unless it is:
 *
 *   - bridge/transport plumbing (the reserved list below), or
 *   - prefixed with `_`, the convention for ephemeral UI state an app wants in
 *     its own URL but not in a shareable link (`_modal`, `_tab`, …).
 *
 * Global-by-default is the right polarity: a param only exists in the URL
 * because the app author deliberately put it there, which is already a
 * statement that it is view state worth restoring. Requiring apps to opt in
 * would silently drop exactly the params users care about — the failure mode
 * we are fixing.
 */

/**
 * Params owned by the platform's embed transport. These are injected into the
 * iframe URL and are never app view state. `session_token` in particular is a
 * short-lived credential and must not reach the parent address bar.
 */
export const BRIDGE_RESERVED_PARAMS: readonly string[] = [
    'session_token',
    'parent_origin',
    'app_id',
    'profile_id',
    'installed_app_id',
    'instance_id',
    'target',
    'locale',
    'embed',
    // The host's own carrier for the app path — reflecting it back would nest.
    'path',
];

/** Prefix marking a param as app-private (never shared to the host URL). */
export const EPHEMERAL_PARAM_PREFIX = '_';

/**
 * True when a query param should be reflected into the host's address bar.
 *
 * Exported so the host and any future runtime (PHP, Python) can apply the
 * identical rule rather than re-deriving it.
 */
export function isGlobalParam(key: string): boolean {
    if (key === '') return false;
    if (key.startsWith(EPHEMERAL_PARAM_PREFIX)) return false;
    return !BRIDGE_RESERVED_PARAMS.includes(key);
}

/**
 * Split a search string into the params that belong in the host URL.
 *
 * Repeated keys are preserved as repeated entries (`?tag=a&tag=b`) because
 * dropping duplicates would quietly break multi-select filters.
 *
 * @param search A `?a=1&b=2` style string (leading `?` optional).
 * @returns Ordered [key, value] pairs that passed {@link isGlobalParam}.
 */
export function globalParamsOf(search: string): Array<[string, string]> {
    if (search === '' || typeof URLSearchParams === 'undefined') return [];

    const params = new URLSearchParams(search.startsWith('?') ? search.slice(1) : search);
    const out: Array<[string, string]> = [];

    params.forEach((value, key) => {
        if (isGlobalParam(key)) out.push([key, value]);
    });

    return out;
}

/**
 * Normalise an app-relative path. Guarantees a leading slash, no trailing
 * slash (except root), and strips any scheme/host someone passed by mistake.
 */
export function normaliseAppPath(path: string): string {
    let p = String(path ?? '').trim();
    if (p === '') return '/';

    // Defensive: never let an absolute URL through as a "path".
    const schemeIndex = p.indexOf('://');
    if (schemeIndex !== -1) {
        const rest = p.slice(schemeIndex + 3);
        const slash = rest.indexOf('/');
        p = slash === -1 ? '/' : rest.slice(slash);
    }

    if (!p.startsWith('/')) p = '/' + p;
    // Drop any query/hash — those travel separately as structured params.
    p = p.split('?')[0]!.split('#')[0]!;
    if (p.length > 1) p = p.replace(/\/+$/, '');

    return p === '' ? '/' : p;
}

/** The payload shape sent to the host on every in-app navigation. */
export interface PathChangePayload {
    /** App-relative path, normalised. */
    path: string;
    /** Shareable query params, in order. Empty when the app has none. */
    query: Array<[string, string]>;
}

/**
 * Build the PATH_CHANGE payload for a location.
 *
 * @param pathname Current app pathname.
 * @param search   Current app search string.
 */
export function buildPathChangePayload(pathname: string, search: string): PathChangePayload {
    return {
        path: normaliseAppPath(pathname),
        query: globalParamsOf(search),
    };
}

/**
 * Rebuild an app-relative URL from a host-provided path + params. Used on the
 * deep-link side: the host hands back what it stored, and the app restores
 * both the page AND the view state that was on it.
 */
export function buildAppUrl(path: string, query: Array<[string, string]> | undefined): string {
    const base = normaliseAppPath(path);
    if (query === undefined || query.length === 0) return base;

    const params = new URLSearchParams();
    for (const [key, value] of query) {
        if (isGlobalParam(key)) params.append(key, value);
    }

    const qs = params.toString();
    return qs === '' ? base : `${base}?${qs}`;
}
