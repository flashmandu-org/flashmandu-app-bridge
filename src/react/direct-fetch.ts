/**
 * `directFetch` / `directHeaders` on the shared bridge singleton (0.6.6).
 *
 * Use for every call to the app's OWN server that makes the server talk to
 * the host for this store (Media Library upload/pick/delete, host GraphQL).
 * The server side is `hostClientFor(req, cfg)` in `@flashmandu/app-bridge/server`.
 * See `../direct-fetch.ts` for the wire contract.
 */

import { createDirectFetch, directTokenHeaders } from '../direct-fetch.js';
import { getBridge } from './use-app-bridge.js';

/** `fetch` with the host-minted direct token in `X-Flashmandu-Direct-Token`. */
export function directFetch(url: string, init?: RequestInit): Promise<Response> {
    return createDirectFetch(getBridge())(url, init);
}

/**
 * The direct-token header as an object, for an XMLHttpRequest (upload
 * progress). `{}` when none can be minted. `force` re-mints: use it for the
 * one retry after a 401 carrying `X-Flashmandu-Direct-Token-Rejected`.
 */
export function directHeaders(options: { force?: boolean } = {}): Promise<Record<string, string>> {
    return directTokenHeaders(getBridge(), options);
}
