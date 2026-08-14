import { createHmac, timingSafeEqual } from 'node:crypto';

import type { AppConfig } from './config.js';

/**
 * Embed-token verification + profile resolution for admin API routes.
 *
 * Merged from the tours/orbit app template's `lib/token.ts` (154 ln, the
 * token algorithm) and `lib/server-auth.ts` (117 ln, request-level
 * resolution) — the lazy-secret variant (spec §2.1: interactive-map's
 * `server-auth.ts` resolved the secret at MODULE scope, which threw on
 * `next build` without provisioned credentials; tours/orbit fixed it by
 * resolving lazily, and that is the canonical pattern this package ports).
 *
 * Laziness is preserved end to end: `resolveProfile` calls `cfg.appSecret()`
 * at CALL time (inside the request handler), and `AppConfig.appSecret()`
 * itself memoizes and only throws when invoked — never at import or
 * `loadConfig()` time.
 *
 * The admin iframe is embedded by the host platform, which gates access
 * itself. For admin routes (model CRUD), a bare `?profileId=` query param is
 * accepted because the iframe embed is the auth gate.
 *
 * Resolution order (`resolveSession` / `resolveProfile`):
 *   1. `Authorization: Bearer <token>` header, or `?session_token=<token>`
 *      query param (verified against `cfg.appSecret()`)
 *   2. `?profileId=<n>` query param (accepted in all environments since the
 *      admin iframe is already access-gated by the host)
 *
 * `resolveSession`/`requireSession` are the SYNCHRONOUS session surface most
 * app route handlers actually want: the full verified token payload (not
 * just the profile id), a typed `AuthError` for a one-line 401 rewrite, and
 * no `await` at every call site. `resolveProfile` (async, bare profile-id
 * string) is kept for existing callers and is now expressed in terms of
 * `resolveSession` — there is exactly one resolution implementation.
 */

export type VerifyTokenOk = { ok: true; payload: Record<string, string> };
export type VerifyTokenBad = { ok: false; reason: string };
export type VerifyTokenResult = VerifyTokenOk | VerifyTokenBad;

/** RFC 3986 unreserved set is A-Z a-z 0-9 - . _ ~. encodeURIComponent encodes
 *  everything else (including !'()*), which matches RFC 3986 component encoding. */
function rfc3986Encode(value: string): string {
    return encodeURIComponent(value);
}

/** base64url decode tolerant of missing padding. */
function base64urlDecode(input: string): Buffer {
    const pad = input.length % 4 === 0 ? '' : '='.repeat(4 - (input.length % 4));
    return Buffer.from(input + pad, 'base64url');
}

/**
 * Build the canonical sorted query string from a payload:
 *   keys ascending -> `key=RFC3986(value)` -> joined by '&'.
 */
function sortedQuery(payload: Record<string, string>): string {
    return Object.keys(payload)
        .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
        .map((k) => `${k}=${rfc3986Encode(String(payload[k]))}`)
        .join('&');
}

/** Constant-time buffer compare; length-mismatch returns false without throwing. */
function safeEqualBuf(a: Buffer, b: Buffer): boolean {
    if (a.length !== b.length || a.length === 0) {
        return false;
    }
    return timingSafeEqual(a, b);
}

/**
 * Verify a `<body>.<sig>` embed / session token against a secret.
 *
 * Implements the signed-token algorithm shared by the storefront identity
 * token and the App Bridge admin session token. Both are HMAC-SHA256 over a
 * canonical signing input, encoded as:
 *
 *   token = `<body>.<sig>`
 *   body  = base64url( json(payload) )                    // payload: flat scalar map
 *   sig   = base64url( hmac_sha256( body + "\n" + sorted_query(payload), secret ) )
 *
 * where `sorted_query(payload)` is built by sorting payload keys ASCENDING and
 * joining `key=RFC3986(value)` pairs with '&'.
 *
 * Verification rebuilds `sorted_query` from the DECODED payload (so it is
 * canonical regardless of key order or whitespace in the transmitted JSON),
 * recomputes the HMAC, and compares in constant time. The token is a CONTEXT
 * CARRIER only — single-use / TTL enforcement is the platform's job at
 * `/apps/embed/render`; this function only checks structural + signature
 * integrity.
 *
 * Returns the decoded payload (as a flat string map) and a reason string on
 * failure. Never throws.
 */
export function verifyEmbedTokenDetailed(token: string, secret: string): VerifyTokenResult {
    if (typeof token !== 'string' || token.length === 0) {
        return { ok: false, reason: 'empty token' };
    }

    const dot = token.lastIndexOf('.');
    if (dot <= 0 || dot >= token.length - 1) {
        return { ok: false, reason: 'malformed' };
    }
    const body = token.slice(0, dot);
    const sig = token.slice(dot + 1);

    let bodyBuf: Buffer;
    try {
        bodyBuf = base64urlDecode(body);
    } catch {
        return { ok: false, reason: 'invalid body base64url' };
    }

    let payload: Record<string, string>;
    try {
        const parsed = JSON.parse(bodyBuf.toString('utf8')) as unknown;
        if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
            return { ok: false, reason: 'payload is not a JSON object' };
        }
        const normalized: Record<string, string> = {};
        for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
            if (v !== null && v !== undefined && typeof v === 'object') {
                return { ok: false, reason: `payload value '${k}' is not scalar` };
            }
            normalized[k] = v === null || v === undefined ? '' : String(v);
        }
        payload = normalized;
    } catch {
        return { ok: false, reason: 'payload is not valid JSON' };
    }

    // Rebuild the canonical sorted query from the DECODED payload, so this is
    // invariant under key reordering or whitespace changes in the transmitted body.
    const signingInput = `${body}\n${sortedQuery(payload)}`;
    const expected = createHmac('sha256', secret).update(signingInput, 'utf8').digest();

    let provided: Buffer;
    try {
        provided = base64urlDecode(sig);
    } catch {
        return { ok: false, reason: 'invalid signature base64url' };
    }

    if (!safeEqualBuf(expected, provided)) {
        return { ok: false, reason: 'signature mismatch' };
    }

    // Freshness: if the payload carries an `exp` (unix seconds), reject once it
    // has elapsed. The token is otherwise only a context carrier.
    if (payload.exp !== undefined) {
        const exp = Number(payload.exp);
        if (Number.isFinite(exp) && exp <= Math.floor(Date.now() / 1000)) {
            return { ok: false, reason: 'expired' };
        }
    }

    return { ok: true, payload };
}

/**
 * Mint an embed / session token for LOCAL DEV TESTING.
 *
 * Mirrors the platform's EmbedBlockTester mint so the app (and its unit tests)
 * can self-test without the platform running. Always injects `iat` (now) and
 * `exp` (now + ttlSeconds, unix seconds) into the payload before signing —
 * `ttlSeconds: 0` therefore yields a token that is already expired, so freshness
 * rejection can be exercised. The signing algorithm is exactly the inverse of
 * `verifyEmbedTokenDetailed`.
 *
 * Returns the `<body>.<sig>` token STRING.
 */
export function mintEmbedToken(
    payload: Record<string, string>,
    secret: string,
    ttlSeconds: number = 60,
): string {
    const now = Math.floor(Date.now() / 1000);
    const full: Record<string, string> = { ...payload, iat: String(now), exp: String(now + ttlSeconds) };

    const body = Buffer.from(JSON.stringify(full), 'utf8').toString('base64url');
    const signingInput = `${body}\n${sortedQuery(full)}`;
    const sig = createHmac('sha256', secret).update(signingInput, 'utf8').digest('base64url');

    return `${body}.${sig}`;
}

/**
 * Verify an embed token and return just its profile id — the shape most
 * callers want. Returns `null` on any verification failure or when the
 * payload carries no usable `profile_id`. Use
 * {@link verifyEmbedTokenDetailed} instead when the failure reason matters.
 */
export function verifyEmbedToken(token: string, secret: string): { profileId: string } | null {
    const result = verifyEmbedTokenDetailed(token, secret);
    if (!result.ok) {
        return null;
    }
    const pid = Number.parseInt(result.payload.profile_id ?? '', 10);
    if (!Number.isFinite(pid) || pid <= 0) {
        return null;
    }
    return { profileId: String(pid) };
}

/** A resolved caller identity: the numeric profile id plus the full verified token payload. */
export interface SessionInfo {
    profileId: number;
    /** The raw token payload (for additional context beyond profile_id, e.g. role). */
    payload: Record<string, string>;
}

/**
 * Structured error with an HTTP status code, for API route handlers to catch
 * and turn into a response (`requireSession` throws this).
 */
export class AuthError extends Error {
    constructor(
        message: string,
        public status: number = 401,
    ) {
        super(message);
        this.name = 'AuthError';
    }
}

/**
 * Resolve the caller's session from an admin API request. SYNCHRONOUS.
 *
 * Order: `?session_token=` query param or `Authorization: Bearer` header
 * (verified against `cfg.appSecret()`, called lazily here — not before),
 * then bare `?profileId=` — accepted because the iframe embed is the auth
 * gate. Returns `null` when neither resolves. Never throws merely because
 * `cfg.appSecret()` is unprovisioned.
 */
export function resolveSession(req: Request, cfg: AppConfig): SessionInfo | null {
    const url = new URL(req.url);

    const auth = req.headers.get('authorization') ?? '';
    const bearer = auth.toLowerCase().startsWith('bearer ') ? auth.slice(7).trim() : null;
    // Query param overrides header for flexibility.
    const sessionToken = url.searchParams.get('session_token') ?? bearer;

    if (sessionToken) {
        let secret = '';
        try {
            secret = cfg.appSecret();
        } catch {
            secret = '';
        }
        if (secret) {
            const result = verifyEmbedTokenDetailed(sessionToken, secret);
            if (result.ok) {
                const pid = Number.parseInt(result.payload.profile_id ?? '', 10);
                if (Number.isFinite(pid) && pid > 0) {
                    return { profileId: pid, payload: result.payload };
                }
            }
        }
    }

    // Bare ?profileId= — accepted in admin routes since the host's iframe
    // embed is the access gate (not the token).
    const raw = url.searchParams.get('profileId');
    if (raw) {
        const pid = Number.parseInt(raw, 10);
        if (Number.isFinite(pid) && pid > 0) {
            return { profileId: pid, payload: { profile_id: String(pid) } };
        }
    }

    return null;
}

/**
 * Resolve the caller's session, throwing a structured {@link AuthError}
 * (suitable for an API route's catch block) when unauthenticated.
 */
export function requireSession(req: Request, cfg: AppConfig): SessionInfo {
    const session = resolveSession(req, cfg);
    if (!session) {
        throw new AuthError(
            'Authentication required. Provide a valid session token via ' +
                'Authorization: Bearer or ?session_token=.',
            401,
        );
    }
    return session;
}

/**
 * Resolve the caller's profile id from an admin API request.
 *
 * Async, bare-string surface kept for existing callers; expressed in terms
 * of {@link resolveSession} so there is a single resolution implementation.
 * Returns `null` when neither a valid token nor `?profileId=` resolves.
 */
export async function resolveProfile(req: Request, cfg: AppConfig): Promise<string | null> {
    const session = resolveSession(req, cfg);
    return session ? String(session.profileId) : null;
}
