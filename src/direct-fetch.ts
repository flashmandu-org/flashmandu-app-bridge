/**
 * directFetch (0.6.6) — the browser half of "act for THIS store".
 *
 * WHY. An app's pod holds ONE `FLASHMANDU_API_TOKEN`, minted for one install
 * and short-lived, so the app's server cannot use it to act for whichever
 * store the merchant has open. The token that IS per install is the host's
 * DIRECT token, which only the iframe can obtain (TOKEN_REFRESH). So the
 * browser hands it to the app's OWN server on each call that needs the host,
 * in {@link DIRECT_TOKEN_HEADER}; the server builds its host client from it
 * (`hostClientFor` in `@flashmandu/app-bridge/server`), checks `me()` belongs
 * to the session's profile, and fails closed otherwise.
 *
 * WIRE CONTRACT (fixed with the host lane):
 *   request   `X-Flashmandu-Direct-Token: <direct token>` → the app server
 *             uses it as the Bearer for host `/api/apps/me`, `/api/apps/media`
 *             and `/api/apps/graphql`.
 *   response  401 + `X-Flashmandu-Direct-Token-Rejected: 1` when the HOST
 *             refused the token (expired between mint and use). directFetch
 *             re-mints ONCE and retries; any other 401 is returned as is.
 *
 * Framework-free and kept out of `createAppBridge` so an app that never calls
 * it pays no bytes for it. The token cache, single-flight refresh and
 * provenance rule all stay in the bridge (`bridge.getDirectToken()`); this
 * module only attaches the header. Never copy the token logic into an app.
 */

/** Request header carrying the host-minted direct token to the app's own server. */
export const DIRECT_TOKEN_HEADER = 'X-Flashmandu-Direct-Token';

/** Response header the app's server sets when the HOST rejected that token. */
export const DIRECT_TOKEN_REJECTED_HEADER = 'X-Flashmandu-Direct-Token-Rejected';

/** The slice of the bridge directFetch needs (`AppBridge` satisfies it). */
export interface DirectTokenSource {
    getDirectToken: (options?: { force?: boolean }) => Promise<string>;
}

export type DirectFetch = (url: string, init?: RequestInit) => Promise<Response>;

export interface DirectFetchOptions {
    /**
     * The app's own origin. Default: `location.origin` in a browser, else null
     * (then only path-relative URLs pass). The token is sent ONLY to it.
     */
    origin?: string | null;
}

function defaultOrigin(): string | null {
    const loc = (globalThis as { location?: { origin?: string } }).location;
    return typeof loc?.origin === 'string' && loc.origin !== 'null' ? loc.origin : null;
}

/**
 * True when `url` targets the app's OWN origin. With no known origin only a
 * path-relative URL qualifies: never a scheme, `//host` or `/\\host`.
 */
export function isOwnOrigin(url: string, origin: string | null = defaultOrigin()): boolean {
    if (origin !== null) {
        try {
            const own = new URL(origin).origin;
            return new URL(url, own).origin === own;
        } catch {
            return false;
        }
    }
    return !/^[a-z][a-z0-9+.-]*:/i.test(url) && !/^[\\/]{2}/.test(url) && !/^\s/.test(url);
}

function assertOwnOrigin(url: string, origin: string | null): void {
    if (!isOwnOrigin(url, origin)) {
        throw new Error('The direct token is only sent to this app\'s own origin; use plain fetch for other hosts.');
    }
}

/** The token, or null when the host cannot mint one (the server then refuses in its own words). */
async function tokenOrNull(bridge: DirectTokenSource, force: boolean): Promise<string | null> {
    try {
        const token = await bridge.getDirectToken({ force });
        return token === '' ? null : token;
    } catch {
        return null;
    }
}

function withToken(init: RequestInit, token: string | null): RequestInit {
    const headers = new Headers(init.headers);
    if (token !== null) {
        headers.set(DIRECT_TOKEN_HEADER, token);
    } else {
        headers.delete(DIRECT_TOKEN_HEADER);
    }
    return { ...init, headers };
}

/** True when the body can be sent a second time (a stream cannot). */
function replayable(init: RequestInit): boolean {
    return !(typeof ReadableStream !== 'undefined' && init.body instanceof ReadableStream);
}

/**
 * Bind a `fetch` that carries the bridge's direct token. `fetchImpl` defaults
 * to the global `fetch` (a test seam otherwise).
 */
export function createDirectFetch(bridge: DirectTokenSource, fetchImpl?: typeof fetch, options: DirectFetchOptions = {}): DirectFetch {
    const send = (url: string, init: RequestInit): Promise<Response> => (fetchImpl ?? fetch)(url, init);
    return async (url, init = {}) => {
        // Before any mint: a cross-origin URL never sees the token (it rejects).
        assertOwnOrigin(url, options.origin === undefined ? defaultOrigin() : options.origin);
        const first = await send(url, withToken(init, await tokenOrNull(bridge, false)));
        if (first.status !== 401 || first.headers.get(DIRECT_TOKEN_REJECTED_HEADER) === null || !replayable(init)) {
            return first;
        }
        return send(url, withToken(init, await tokenOrNull(bridge, true)));
    };
}

/**
 * The header as a plain object, for a request directFetch cannot make — an
 * `XMLHttpRequest` upload that needs progress events. `url` is where it will
 * be sent: a cross-origin URL rejects (the token only goes to the app's own
 * origin). `{}` when the host cannot mint a token.
 */
export async function directTokenHeaders(
    bridge: DirectTokenSource,
    url: string,
    options: DirectFetchOptions & { force?: boolean } = {},
): Promise<Record<string, string>> {
    assertOwnOrigin(url, options.origin === undefined ? defaultOrigin() : options.origin);
    const token = await tokenOrNull(bridge, options.force === true);
    return token === null ? {} : { [DIRECT_TOKEN_HEADER]: token };
}
