/**
 * Why `bridge.graphql()` could not answer — as a code, not as prose.
 *
 * Every rejection out of `graphql()` used to be a bare `Error` whose only
 * signal was an English sentence. An app that wanted to react differently to
 * "this host has no direct path" (fall back to the proxy, permanently) and
 * "the token expired" (retry) had to substring-match that sentence, so in
 * practice nothing reacted at all and every failure surfaced to the merchant
 * as the same opaque line.
 *
 * The codes are deliberately about the CAUSE the app can act on, not about the
 * HTTP status that carried it — `origin_not_allowed` and `invalid_token` are
 * both 401/403 on the wire and need completely different fixes (register the
 * app's origin vs. re-mint a token).
 */
export type GraphqlErrorCode =
    /** The host never announced `capabilities.directApi`. Permanent for this session. */
    | 'capability_not_announced'
    /** `disableDirectApi` was passed to `createAppBridge()`. Deliberate, app-side. */
    | 'direct_api_disabled'
    /** CONTEXT has not arrived yet, so the platform origin is unknown. */
    | 'context_not_ready'
    /** No `fetch` in this runtime. */
    | 'no_fetch'
    /** The host could not mint a token — TOKEN carried an error, or timed out. */
    | 'token_refresh_failed'
    /** The endpoint rejected the credential (HTTP 401 `invalid_token`). */
    | 'invalid_token'
    /** The token was valid but is not usable from this origin (`origin_mismatch`). */
    | 'origin_mismatch'
    /** This origin is not registered by any installed app (HTTP 403). */
    | 'origin_not_allowed'
    /** The app's granted scopes do not cover the read (HTTP 403). */
    | 'scope_denied'
    /** The fetch never completed: DNS, connection refused, or a blocked preflight. */
    | 'network'
    /** An empty or non-string query document. */
    | 'invalid_query'
    /** The bridge was destroyed before the call could finish. */
    | 'bridge_destroyed';

/**
 * A `graphql()` rejection that NAMES its cause.
 *
 * `instanceof Error` still holds, so existing `catch (e) { e.message }` code is
 * unaffected; `code` is the addition. The message is written to be shown to a
 * developer verbatim — it says what happened AND what to do about it, because
 * the whole failure mode this replaces was a developer staring at a rejection
 * with nowhere to go.
 */
export class BridgeGraphqlError extends Error {
    readonly code: GraphqlErrorCode;

    /** HTTP status when one was actually received; null when nothing was sent. */
    readonly status: number | null;

    /** The platform's own `error` slug, when the response body carried one. */
    readonly serverCode: string | null;

    constructor(
        code: GraphqlErrorCode,
        message: string,
        options: { status?: number | null; serverCode?: string | null; cause?: unknown } = {},
    ) {
        super(message);
        this.name = 'BridgeGraphqlError';
        this.code = code;
        this.status = options.status ?? null;
        this.serverCode = options.serverCode ?? null;
        if (options.cause !== undefined) {
            (this as { cause?: unknown }).cause = options.cause;
        }
    }
}

/**
 * Map a platform error body onto a code.
 *
 * The endpoint answers a small, closed set of `error` slugs
 * (`invalid_token`, `origin_mismatch`, `origin_not_allowed`), and those are far
 * more precise than the status they ride on. Falls back to a status-derived
 * guess so an unrecognised body still produces something better than "failed".
 */
export function classifyDirectApiFailure(
    status: number,
    body: unknown,
): { code: GraphqlErrorCode; serverCode: string | null; message: string } {
    const slug = readErrorSlug(body);
    const detail = readErrorMessage(body);

    if (slug === 'invalid_token') {
        return {
            code: 'invalid_token',
            serverCode: slug,
            message:
                'The platform rejected the embed token (HTTP 401 invalid_token). The token is ' +
                'missing, expired, or was minted for a different app. The bridge re-mints through ' +
                'the host on TOKEN_REFRESH; a persistent failure means the host cannot mint for ' +
                'this app — check that the embed page knows the app id.',
        };
    }

    if (slug === 'origin_mismatch') {
        return {
            code: 'origin_mismatch',
            serverCode: slug,
            message:
                'The embed token is valid but may only be spent from its own app origin ' +
                '(HTTP 401 origin_mismatch). The frame is served from a different origin than the ' +
                "one this app registered — check the install's embed_url.",
        };
    }

    if (slug === 'origin_not_allowed') {
        return {
            code: 'origin_not_allowed',
            serverCode: slug,
            message:
                'This origin is not registered by any installed app (HTTP 403 origin_not_allowed), ' +
                'so the direct endpoint refuses it before authentication. Register the origin on ' +
                "the install (embed_url, or the dev-loop webhook_url's origin).",
        };
    }

    if (status === 403) {
        return {
            code: 'scope_denied',
            serverCode: slug,
            message: detail !== null
                ? `The platform refused this read (HTTP 403): ${detail}`
                : 'The platform refused this read (HTTP 403). The app\'s granted scopes most likely do not cover it.',
        };
    }

    if (status === 401) {
        return {
            code: 'invalid_token',
            serverCode: slug,
            message: detail !== null
                ? `The platform rejected the credential (HTTP 401): ${detail}`
                : 'The platform rejected the credential (HTTP 401).',
        };
    }

    return {
        code: 'network',
        serverCode: slug,
        message: detail !== null
            ? `The platform answered HTTP ${String(status)}: ${detail}`
            : `The platform answered HTTP ${String(status)}.`,
    };
}

/**
 * Is this 401 worth spending a fresh token on?
 *
 * Yes for `invalid_token` (the credential expired or was never good) and for an
 * unlabelled 401 (an intermediary, or an older platform, that did not say). No
 * for `origin_mismatch`, which is about WHERE the frame is served from and is
 * identical for every token this app could ever hold.
 */
export function isRemintable(body: unknown): boolean {
    const slug = readErrorSlug(body);
    return slug === null || slug === 'invalid_token';
}

function readErrorSlug(body: unknown): string | null {
    if (typeof body !== 'object' || body === null) return null;
    const slug = (body as { error?: unknown }).error;
    return typeof slug === 'string' && slug !== '' ? slug : null;
}

function readErrorMessage(body: unknown): string | null {
    if (typeof body !== 'object' || body === null) return null;
    const message = (body as { message?: unknown }).message;
    return typeof message === 'string' && message !== '' ? message : null;
}
