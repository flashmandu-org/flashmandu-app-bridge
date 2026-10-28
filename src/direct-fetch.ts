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
export function createDirectFetch(bridge: DirectTokenSource, fetchImpl?: typeof fetch): DirectFetch {
    const send = (url: string, init: RequestInit): Promise<Response> => (fetchImpl ?? fetch)(url, init);
    return async (url, init = {}) => {
        const first = await send(url, withToken(init, await tokenOrNull(bridge, false)));
        if (first.status !== 401 || first.headers.get(DIRECT_TOKEN_REJECTED_HEADER) === null || !replayable(init)) {
            return first;
        }
        return send(url, withToken(init, await tokenOrNull(bridge, true)));
    };
}

/**
 * The header as a plain object, for a request directFetch cannot make — an
 * `XMLHttpRequest` upload that needs progress events. `{}` when the host
 * cannot mint a token.
 */
export async function directTokenHeaders(bridge: DirectTokenSource, options: { force?: boolean } = {}): Promise<Record<string, string>> {
    const token = await tokenOrNull(bridge, options.force === true);
    return token === null ? {} : { [DIRECT_TOKEN_HEADER]: token };
}
