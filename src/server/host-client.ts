/**
 * hostClientFor (0.6.6) — the server half of "act for THIS store".
 *
 * A pod's `FLASHMANDU_API_TOKEN` is minted for ONE install and lives minutes,
 * so it cannot act for each store. The browser (`directFetch`) sends the
 * host-minted per-install DIRECT token in `X-Flashmandu-Direct-Token`; this
 * builds the host client from that header plus `cfg.apiBase`, the Bearer for
 * `/api/apps/me`, `/api/apps/media` and `/api/apps/graphql`.
 *
 * TENANCY, FAIL CLOSED. Before the client is handed out, `me()` must answer
 * and its `profile_id` must equal the session's profile (or the `profileId`
 * the caller already resolved). Every doubt throws a {@link HostClientError};
 * there is no fallback to the pod token. The verified `me()` is cached on the
 * returned client, so a caller that checks it again costs no round trip.
 *
 * NOT for work with no browser behind it (webhooks, MCP): those carry no
 * direct token. MCP calls get a short-lived `api_token` in their signed body;
 * build `createFlashmanduClient({ apiBase: cfg.apiBase, token })` from it.
 */

import { DIRECT_TOKEN_HEADER, DIRECT_TOKEN_REJECTED_HEADER } from '../direct-fetch.js';
import { resolveSession } from './auth.js';
import type { AppConfig } from './config.js';
import { createFlashmanduClient, FlashmanduApiError, type FlashmanduClient } from './flashmandu.js';

export type HostClientErrorCode =
    /** No `X-Flashmandu-Direct-Token` on the request (an old bridge, or not from the iframe). */
    | 'direct_token_missing'
    /** The host answered 401 to the token: re-mint and retry once (directFetch does). */
    | 'direct_token_rejected'
    /** No session profile to check the token against. */
    | 'no_session'
    /** `FLASHMANDU_API_BASE` (or the dev-box URL) is not set on this server. */
    | 'api_base_missing'
    /** `me()` could not be read (network, 5xx, 403): nothing may be done. */
    | 'host_unreachable'
    /** The token belongs to a different profile than the session's. */
    | 'profile_mismatch';

/** Why no host client could be built. `status` is the HTTP status to answer with. */
export class HostClientError extends Error {
    readonly code: HostClientErrorCode;
    readonly status: number;

    constructor(code: HostClientErrorCode, status: number, message: string, options: { cause?: unknown } = {}) {
        super(message);
        this.name = 'HostClientError';
        this.code = code;
        this.status = status;
        if (options.cause !== undefined) {
            (this as { cause?: unknown }).cause = options.cause;
        }
    }
}

/** The identity `me()` answered for the direct token. */
export type HostIdentity = Awaited<ReturnType<FlashmanduClient['me']>>;

/** A host client proven to act for {@link VerifiedHostClient.profileId}. */
export interface VerifiedHostClient extends FlashmanduClient {
    readonly profileId: number;
    readonly identity: HostIdentity;
}

export interface HostClientForOptions {
    /** The profile already resolved for this request; default: `resolveSession(req, cfg)`. */
    profileId?: number;
}

/**
 * Build the per-request host client, or throw a {@link HostClientError}. See
 * the module doc for the contract.
 */
export async function hostClientFor(req: Request, cfg: AppConfig, options: HostClientForOptions = {}): Promise<VerifiedHostClient> {
    const token = (req.headers.get(DIRECT_TOKEN_HEADER) ?? '').trim();
    if (token === '') {
        throw new HostClientError('direct_token_missing', 401, `The request carries no ${DIRECT_TOKEN_HEADER} header.`);
    }
    if (cfg.apiBase === '') {
        throw new HostClientError('api_base_missing', 503, 'FLASHMANDU_API_BASE is not set on this server.');
    }
    const profileId = options.profileId ?? resolveSession(req, cfg)?.profileId;
    if (profileId === undefined || !Number.isInteger(profileId) || profileId <= 0) {
        throw new HostClientError('no_session', 401, 'No session profile to check the direct token against.');
    }

    const client = createFlashmanduClient({ apiBase: cfg.apiBase, token });
    let identity: HostIdentity;
    try {
        identity = await client.me();
    } catch (cause) {
        if (cause instanceof FlashmanduApiError && cause.status === 401) {
            throw new HostClientError('direct_token_rejected', 401, 'The host rejected the direct token.', { cause });
        }
        throw new HostClientError('host_unreachable', 502, 'The host identity (me) could not be read.', { cause });
    }
    if (Number(identity.profile_id) !== profileId) {
        throw new HostClientError(
            'profile_mismatch',
            403,
            `The direct token belongs to profile ${String(identity.profile_id)}, not ${String(profileId)}.`,
        );
    }
    return { ...client, profileId, identity, me: async () => identity };
}

/**
 * Headers to add to the error response for a {@link HostClientError}: the
 * rejected marker that tells `directFetch` to re-mint once, else nothing.
 */
export function hostClientErrorHeaders(err: HostClientError): Record<string, string> {
    return err.code === 'direct_token_rejected' ? { [DIRECT_TOKEN_REJECTED_HEADER]: '1' } : {};
}
