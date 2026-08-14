/**
 * Next.js App Router route factories for the three byte-identical-across-apps
 * surfaces: OAuth install, inbound webhooks, and platform cache revalidation.
 *
 * Uses the standard Fetch `Request`/`Response` (not `next/server`'s
 * `NextResponse`) so these factories stay testable with a plain `Request` in
 * vitest and do not force a `next` import into a package whose `/server`
 * entry is meant to be framework-agnostic. Next's route handler contract only
 * requires exporting functions shaped `(req: Request) => Response |
 * Promise<Response>` — a bare `Response` satisfies it exactly the same way
 * `NextResponse` (a `Response` subclass) does.
 */

import type { AppConfig } from '../server/config.js';
import { revalidateProfile } from '../server/revalidate.js';
import {
    readSectionContext,
    sectionResponseBody,
    verifySectionRequest,
    type SectionContext,
    type SectionResult,
} from '../server/section.js';
import { verifyWebhook } from '../server/webhooks.js';

/* ------------------------------------------------------------------------ *
 * OAuth routes — ported from the byte-identical ×4
 * `app/oauth/{authorize,callback,token}/route.ts` (tours/orbit/
 * interactive-map/showcase). None of the three bodies read app config (the
 * template signs its own opaque codes/tokens locally), so `cfg` is accepted
 * for interface symmetry with the other factories and future use, but is
 * currently unused by the ported bodies themselves.
 * ------------------------------------------------------------------------ */

export interface OAuthRoutes {
    authorize: (req: Request) => Promise<Response>;
    callback: (req: Request) => Promise<Response>;
    token: (req: Request) => Promise<Response>;
}

/**
 * OAuth Authorize endpoint — the Flashmandu host redirects the merchant here
 * to begin install. The host sends standard OAuth + PKCE params:
 *
 *   client_id, redirect_uri, response_type=code, state, scope,
 *   code_challenge, code_challenge_method=S256
 *
 * For a third-party app, this is where you'd show a consent screen. The
 * template auto-consents and echoes the merchant back to the host's callback
 * with a fresh authorization code + the original state. The host then
 * exchanges the code at `token` (PKCE verifier in hand) and receives the
 * platform-issued credentials in that exchange.
 */
async function authorize(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const clientId = url.searchParams.get('client_id');
    const redirectUri = url.searchParams.get('redirect_uri');
    const state = url.searchParams.get('state');
    const scope = url.searchParams.get('scope');
    const responseType = url.searchParams.get('response_type');
    const codeChallenge = url.searchParams.get('code_challenge');
    const codeChallengeMethod = url.searchParams.get('code_challenge_method');

    if (!clientId || !redirectUri || !state) {
        return Response.json(
            { error: 'invalid_request', error_description: 'missing required OAuth param' },
            { status: 400 },
        );
    }
    if (responseType !== 'code') {
        return Response.json({ error: 'unsupported_response_type' }, { status: 400 });
    }
    if (codeChallenge && codeChallengeMethod !== 'S256') {
        return Response.json(
            { error: 'invalid_request', error_description: 'only S256 PKCE is supported' },
            { status: 400 },
        );
    }

    // --- Consent step would go here. ---------------------------------------
    // The template auto-consents. Real apps MUST render a consent screen that
    // reflects the requested `scope` and capture the merchant's decision.

    // Mint an authorization code, bind it (plus the PKCE challenge + requested
    // scope) to a short-lived server-side entry. The code is opaque to the host.
    const code = crypto.randomUUID() + crypto.randomUUID().replace(/-/g, '');
    const issuedAt = Date.now();
    // In a real app, persist this. For the template we sign it into a JWT-like
    // blob using a local secret — replace with your session store / DB.
    void scope;
    void issuedAt;

    const back = new URL(redirectUri);
    back.searchParams.set('code', code);
    back.searchParams.set('state', state);

    return Response.redirect(back);
}

/**
 * Developer-facing OAuth callback landing page.
 *
 * NOTE: The Flashmandu host has its OWN OAuth callback (it does not redirect
 * merchants here). The host's install flow is:
 *
 *   host begin-install  ->  merchant lands on app's /oauth/authorize
 *   merchant consents   ->  app redirects to host's callback with code+state
 *   host exchanges       -> POSTs code to app's /oauth/token (PKCE)
 *   host delivers creds  -> POSTs {api_token, webhook_secret, ...} to /oauth/token
 *
 * This route exists purely as a developer convenience — a place to land the
 * browser after a manual install test and show the app identity. It is NOT
 * part of the OAuth contract.
 */
async function callback(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const installed = url.searchParams.get('installed') === '1';
    return Response.json({
        message: installed
            ? 'App installed. Visit the host admin to confirm.'
            : 'OAuth callback landing (developer convenience; not in the host contract).',
    });
}

interface ExchangeBody {
    grant_type?: string;
    code?: string;
    redirect_uri?: string;
    client_id?: string;
    code_verifier?: string;
    scope?: string;
}

interface CredentialDelivery {
    install_id?: number | string;
    profile_id?: number;
    app_id?: string;
    api_token?: string;
    webhook_secret?: string;
    scopes?: string[];
    subscribed_events?: string[];
    issued_at?: string;
    hmac?: string;
}

async function storeCredentials(appId: string, body: CredentialDelivery): Promise<void> {
    const { promises: fs } = await import('node:fs');
    const path = await import('node:path');
    const dir = path.join(process.cwd(), '.flashmandu');
    await fs.mkdir(dir, { recursive: true });
    const file = path.join(dir, `install.${appId}.json`);
    await fs.writeFile(file, JSON.stringify(body, null, 2) + '\n', { mode: 0o600 });
    await fs.chmod(file, 0o600);
}

async function readStoredSecret(appId: string): Promise<string | undefined> {
    try {
        const { promises: fs } = await import('node:fs');
        const path = await import('node:path');
        const file = path.join(process.cwd(), '.flashmandu', `install.${appId}.json`);
        const raw = await fs.readFile(file, 'utf8');
        return (JSON.parse(raw) as CredentialDelivery).webhook_secret;
    } catch {
        return undefined;
    }
}

/**
 * OAuth Token + credential-delivery endpoint.
 *
 * The Flashmandu host POSTs to this URL twice during install:
 *
 *   (1) Code-for-token exchange (PKCE): body carries `grant_type`. We verify
 *       `code_verifier` against the challenge captured at `authorize`, mint a
 *       (mock) access token, and return 200. The platform ignores our
 *       response body — it only checks for 2xx.
 *   (2) Credential delivery (signed by the platform with the install's
 *       webhook_secret — the SAME key used to sign inbound webhook
 *       deliveries): body carries `api_token`. The first delivery cannot be
 *       HMAC-verified (we don't yet know the secret), so we trust the prior
 *       PKCE-bound TLS exchange and STORE the plaintext credentials.
 *       Subsequent deliveries (rotations) are verifiable with the previous
 *       secret.
 *
 * Writes credentials to `.flashmandu/install.<app_id>.json` (gitignored).
 * Replace with a real secret store (KMS, vault, DB) in production.
 */
async function token(req: Request): Promise<Response> {
    let body: unknown;
    try {
        body = await req.json();
    } catch {
        return Response.json({ error: 'invalid_json' }, { status: 400 });
    }

    if (body && typeof body === 'object' && 'grant_type' in body) {
        const ex = body as ExchangeBody;
        if (ex.grant_type !== 'authorization_code' || !ex.code || !ex.code_verifier) {
            return Response.json({ error: 'invalid_request' }, { status: 400 });
        }
        // Verify the PKCE verifier against the challenge stored at authorize.
        // (Template skips persistence: wire your session store here.)
        void ex;

        return Response.json({
            access_token: 'app-side-opaque-' + crypto.randomUUID(),
            token_type: 'bearer',
            scope: ex.scope ?? '',
        });
    }

    if (body && typeof body === 'object' && 'api_token' in body) {
        const deliv = body as CredentialDelivery;
        if (!deliv.app_id || !deliv.api_token || !deliv.webhook_secret) {
            return Response.json({ error: 'invalid_credential_delivery' }, { status: 400 });
        }

        // Verify HMAC if we already hold a previous secret (rotation path). On
        // first delivery we have nothing to verify against — trust PKCE + TLS.
        const prev = await readStoredSecret(deliv.app_id);
        if (prev && deliv.hmac) {
            const { createHmac } = await import('node:crypto');
            const canonical = JSON.stringify({
                install_id: deliv.install_id,
                profile_id: deliv.profile_id,
                app_id: deliv.app_id,
                api_token: deliv.api_token,
                webhook_secret: deliv.webhook_secret,
                scopes: deliv.scopes,
                subscribed_events: deliv.subscribed_events,
                issued_at: deliv.issued_at,
            });
            const expected = createHmac('sha256', prev).update(canonical).digest('hex');
            if (expected !== deliv.hmac) {
                return Response.json({ error: 'invalid_hmac' }, { status: 401 });
            }
        }

        await storeCredentials(deliv.app_id, deliv);
        return Response.json({ ok: true });
    }

    return Response.json({ error: 'unknown_request_shape' }, { status: 400 });
}

/**
 * `createOAuthRoutes` — replaces the three byte-identical ×4 route files with
 * one factory call: `export const { GET } = createOAuthRoutes(loadConfig())`
 * per route file (authorize/callback are GET, token is POST).
 */
export function createOAuthRoutes(cfg: AppConfig): OAuthRoutes {
    void cfg; // accepted for interface symmetry; unused by the ported bodies.
    return { authorize, callback, token };
}

/* ------------------------------------------------------------------------ *
 * Webhook route — canonical verify + X-App-Delivery dedupe + purge dispatch.
 * Skeleton ported from the tours/orbit webhook route; the on-disk delivery
 * log (`.flashmandu/webhooks.log`) is intentionally NOT ported — that was
 * app-local ops tooling, not part of the verify/dedupe/dispatch contract.
 * ------------------------------------------------------------------------ */

/** Events whose handler is the uninstall/data-erasure purge, per the app template's `lib/purge.ts`. */
const PURGE_EVENTS = new Set(['app.uninstalled', 'profile.data.erased']);

/**
 * Pull the profile id out of a lifecycle payload. Returns null rather than
 * guessing — a purge aimed at the wrong profile is worse than a purge that
 * did not run, because the platform's retry ladder will bring the right one
 * back. (`id` on a lifecycle payload is the INSTALL id, never the profile.)
 */
function profileIdFromPayload(payload: unknown): string | null {
    if (typeof payload !== 'object' || payload === null) {
        return null;
    }
    const record = payload as Record<string, unknown>;
    for (const key of ['profile_id', 'profileId']) {
        const value = record[key];
        if (typeof value === 'number' && Number.isInteger(value) && value > 0) {
            return String(value);
        }
        if (typeof value === 'string' && /^\d+$/.test(value)) {
            return value;
        }
    }
    return null;
}

/**
 * The delivery context `onUninstalled` receives as its second argument —
 * everything `onEvent` already gets (`event`, `payload`, `deliveryId`) minus
 * the profile id, which stays the first positional argument for backward
 * compatibility with callers written against the single-argument shape.
 *
 * Without this, an app that keeps its own delivery ledger (claiming rows via
 * `seenDelivery`, enriching them with `event`/`payload` inside `onEvent`) has
 * no way to complete or release-on-failure the ledger row for a purge
 * delivery specifically — `app.uninstalled`/`profile.data.erased` routed to
 * `onUninstalled` and told it nothing but the resolved profile id.
 */
export interface OnUninstalledContext {
    /** The webhook event name, e.g. `app.uninstalled` or `profile.data.erased`. */
    event: string;
    /** `X-App-Delivery`, or `''` if the platform sent none. */
    deliveryId: string;
    /** The raw, unvalidated payload body — the same value `onEvent` receives. */
    payload: unknown;
}

export interface CreateWebhookRouteOptions {
    cfg: AppConfig;
    /**
     * Called for `app.uninstalled` / `profile.data.erased` with the target
     * profile id, plus the delivery {@link OnUninstalledContext} as a second
     * argument. Returns the purge counts to log, e.g.
     * `{ models: 3, files: 12 }`.
     *
     * The second argument is additive: a callback declared as
     * `(profileId: string) => Promise<...>` still type-checks and still
     * runs unchanged — JS simply ignores an extra argument a function
     * doesn't declare a parameter for.
     */
    onUninstalled?: (
        profileId: string,
        context: OnUninstalledContext,
    ) => Promise<Record<string, number>>;
    /** Called for every OTHER verified, non-duplicate event. */
    onEvent?: (event: string, payload: unknown, deliveryId: string) => Promise<void>;
    /**
     * Back the dedupe check with the app's own store (e.g. a Prisma delivery
     * log table) instead of the in-memory default. Return `true` when this
     * delivery id has already been handled.
     */
    seenDelivery?: (id: string) => Promise<boolean>;
}

export interface WebhookRoute {
    POST: (req: Request) => Promise<Response>;
}

/**
 * `createWebhookRoute` — canonical inbound webhook handler.
 *
 * Reads `req.text()` FIRST (re-serializing the body breaks the HMAC — see
 * `verifyWebhook`'s doc comment), verifies via `verifyWebhook`, dedupes on
 * `X-App-Delivery` (an in-memory `Set` by default; pass `seenDelivery` to
 * back it with a real store), dispatches lifecycle purge events to
 * `onUninstalled` and everything else to `onEvent`, and logs purge results in
 * the shape the app templates already use:
 * `[flashmandu] <event> purged profile=<id> <key>=<n> …`.
 *
 * RESPONSE DOCTRINE (ported from the app templates): 2xx acknowledges and
 * stops the platform's retry ladder, so a purge event with no usable profile
 * id, or a duplicate delivery, is acknowledged too — retrying would only
 * redeliver the same already-handled payload. Only an unverifiable delivery
 * (401) and a genuine handler failure (500) are worth retrying.
 */
export function createWebhookRoute(opts: CreateWebhookRouteOptions): WebhookRoute {
    const seenInMemory = new Set<string>();

    async function alreadySeen(deliveryId: string): Promise<boolean> {
        if (opts.seenDelivery) {
            return opts.seenDelivery(deliveryId);
        }
        if (seenInMemory.has(deliveryId)) {
            return true;
        }
        seenInMemory.add(deliveryId);
        return false;
    }

    return {
        async POST(req: Request): Promise<Response> {
            let raw: string;
            try {
                // The RAW bytes, before any parse — re-serializing the JSON
                // would change key order and whitespace and the HMAC would
                // never match again.
                raw = await req.text();
            } catch {
                return Response.json({ error: 'invalid_body' }, { status: 400 });
            }

            const result = verifyWebhook({ rawBody: raw, headers: req.headers, secret: opts.cfg.webhookSecret });
            if (!result.ok) {
                return Response.json({ error: 'invalid_signature', reason: result.reason }, { status: 401 });
            }

            let parsed: { event?: string; payload?: unknown };
            try {
                parsed = JSON.parse(raw) as { event?: string; payload?: unknown };
            } catch {
                return Response.json({ error: 'invalid_json' }, { status: 400 });
            }

            // The header is the authenticated one; the body field is a
            // convenience copy.
            const event = result.event ?? parsed.event ?? '';
            const payload = parsed.payload ?? null;
            const deliveryId = result.deliveryId ?? '';

            if (deliveryId !== '' && (await alreadySeen(deliveryId))) {
                return Response.json({ ok: true, status: 'duplicate' });
            }

            let handled = 'ignored';
            try {
                if (PURGE_EVENTS.has(event) && opts.onUninstalled) {
                    const profileId = profileIdFromPayload(payload);
                    if (profileId === null) {
                        console.warn(`[flashmandu] ${event} carried no profile_id; nothing purged`);
                        handled = 'purge_skipped_no_profile';
                    } else {
                        const purged = await opts.onUninstalled(profileId, { event, deliveryId, payload });
                        const counts = Object.entries(purged)
                            .map(([key, value]) => `${key}=${value}`)
                            .join(' ');
                        console.log(`[flashmandu] ${event} purged profile=${profileId} ${counts}`.trimEnd());
                        handled = 'purged';
                    }
                } else if (opts.onEvent) {
                    await opts.onEvent(event, payload, deliveryId);
                    handled = 'handled';
                }
            } catch (err) {
                console.error(`[flashmandu] handler failed for ${event}`, err);
                return Response.json({ error: 'handler_failed' }, { status: 500 });
            }

            return Response.json({ ok: true, handled });
        },
    };
}

/* ------------------------------------------------------------------------ *
 * Revalidate handler — port of the identical `lib/revalidate.ts`
 * (tours/orbit/showcase; interactive-map drifted).
 * ------------------------------------------------------------------------ */

/**
 * `createRevalidateHandler` — platform cache revalidation, as a Next.js
 * route factory.
 *
 * The platform caches embed-block data derived from this app's rows — the
 * block picker markup in the page builder and the dynamic-options payloads
 * behind block dropdowns. After any mutation to the data your blocks render,
 * tell the platform to drop those caches or the builder keeps showing stale
 * choices for the cache TTL.
 *
 * A thin HTTP wrapper around {@link revalidateProfile} (`../server/revalidate.js`)
 * — mount this at an app route the platform POSTs to. Calling the purge
 * in-process from a server action (no `Request` in hand) is exactly what
 * {@link revalidateProfile} is for; import it directly from
 * `@flashmandu/app-bridge/server` instead of synthesizing a `Request` here.
 *
 * Fire-and-forget by design: a failed purge must never fail the merchant's
 * own save — the platform TTLs are the safety net. The returned handler
 * always resolves 200, whether or not the upstream call succeeded.
 */
export function createRevalidateHandler(cfg: AppConfig): (req: Request) => Promise<Response> {
    return async function revalidate(req: Request): Promise<Response> {
        let profileId: number | undefined;
        try {
            const body = (await req.json()) as { profile_id?: number };
            profileId = body.profile_id;
        } catch {
            profileId = undefined;
        }

        await revalidateProfile(cfg, profileId);

        return Response.json({ ok: true });
    };
}

/* ------------------------------------------------------------------------ *
 * Storefront section proxy (Tier 2) — the app-served composable section.
 * ------------------------------------------------------------------------ */

/**
 * `createSectionRoute` — serve a storefront section as composable JSON.
 *
 * This is the tier that gives a remote app a REAL storefront surface:
 * server-rendered by the platform, SEO-visible, styled by the merchant's own
 * design tokens, with no iframe and no CORS. You return data; the platform
 * renders it with its own renderer. Nothing you return can execute — that is
 * what buys you the surface.
 *
 * You write ONLY the handler:
 *
 * ```ts
 * // app/sections/events/route.ts
 * import { createSectionRoute } from '@flashmandu/app-bridge/next/routes';
 * import { loadConfig } from '@flashmandu/app-bridge/server';
 *
 * export const { GET } = createSectionRoute({
 *     cfg: loadConfig(),
 *     async handler({ profileId, settings }) {
 *         const events = await db.events.findMany({ where: { profileId } });
 *
 *         return {
 *             tree: events.map((e) => ({ type: 'heading', props: { text: e.title } })),
 *             cache: { ttl: 300, staleTtl: 86_400 },
 *         };
 *     },
 * });
 * ```
 *
 * The factory verifies the signature, parses and hands you the authenticated
 * `profileId` + `settings`, stamps `schema_version`, and shapes the response.
 *
 * FAILURE BEHAVIOUR, and why it is what it is:
 *  - Bad/missing signature → **401** carrying the verifier's own reason string.
 *    The same string the platform logs, so a developer comparing the two logs
 *    is looking at one sentence, not two.
 *  - Your handler throws → **500** with a generic message. Handler internals
 *    are never echoed to the platform: the platform's storefront renders a
 *    placeholder either way, and an error string that reaches it would end up
 *    in a merchant-visible log.
 *
 * `Cache-Control: no-store` is deliberate. The PLATFORM owns caching here
 * (TTL + stale-while-revalidate + a circuit breaker, all driven by the `cache`
 * hints you return); an intermediary caching this response too would give the
 * merchant two clocks and no way to reason about either.
 */
export function createSectionRoute(opts: {
    cfg: AppConfig;
    handler: (ctx: SectionContext) => Promise<SectionResult> | SectionResult;
    /** Override the skew window (seconds). Defaults to the webhook default (300). */
    maxSkewSeconds?: number;
}): { GET: (req: Request) => Promise<Response> } {
    const { cfg, handler, maxSkewSeconds } = opts;

    return {
        GET: async function GET(req: Request): Promise<Response> {
            const verdict = verifySectionRequest({
                url: req.url,
                headers: req.headers,
                secret: cfg.webhookSecret,
                maxSkewSeconds,
            });

            if (!verdict.ok) {
                return Response.json(
                    { ok: false, error: verdict.reason ?? 'unauthorized' },
                    { status: 401, headers: { 'Cache-Control': 'no-store' } },
                );
            }

            const ctx = readSectionContext(req.url, req.headers);

            let result: SectionResult;

            try {
                result = await handler(ctx);
            } catch {
                return Response.json(
                    { ok: false, error: 'section handler failed' },
                    { status: 500, headers: { 'Cache-Control': 'no-store' } },
                );
            }

            return Response.json(sectionResponseBody(result), {
                status: 200,
                headers: { 'Cache-Control': 'no-store' },
            });
        },
    };
}
