/**
 * Public App Bridge API (protocol v2).
 *
 * The embedded app holds a single `AppBridge` instance, awaited through
 * `ready()` for the parent's CONTEXT, then drives the platform through
 * `request()`, `toast()`, `navigate()`, `setPage()` and friends. The bridge
 * reads its signed session params from `window.location.search` (the embed
 * shell stamps `session_token`, `app_id`, `profile_id`, `target`,
 * `parent_origin`, …) and posts `READY` to `window.parent` on construction.
 *
 * WHAT LIVES HERE AND WHAT DOES NOT
 * ---------------------------------
 * This module is the CORE bundle every embedded app pays for, so it carries
 * only what every app needs. Modal + picker are built on the public
 * {@link BridgeChannel} seam and shipped from `@flashmandu/app-bridge/modal`
 * so an app that never opens a modal does not ship its validation tables; the
 * mock host lives in `@flashmandu/app-bridge/testing` for the same reason.
 */

import {
    type ActionPayload,
    type AppContext,
    type BridgeMessage,
    type BridgeChannel,
    type BridgeListener,
    type ContextPayload,
    type HostCapabilities,
    type PickerKind,
    type ProxyResponsePayload,
    type RequestOptions,
    type ResponseResult,
    type SetPagePayload,
    type SidebarLink,
    type ToastAction,
    type ToastVariant,
    type TokenPayload,
} from './types.js';
import { MessageType } from './types.js';
import {
    createBrowserTransport,
    readQueryParam,
    resolveParentOrigin,
    type Transport,
} from './transport.js';
import { isAppRelativePath, isHostNavigablePath, normalisePageChrome } from './page-chrome.js';
import {
    backoffDelayMs,
    DEFAULT_RETRY_POLICY,
    parseRemaining,
    parseRetryAfter,
    type RetryPolicy,
    shouldRetry,
} from './retry.js';

/** Design §4.7: the direct API endpoint, unless the host names another. */
export const DEFAULT_DIRECT_API_ENDPOINT = '/api/apps/graphql';

/** Design §4.6: refresh once the cached token has less than this left. */
export const TOKEN_FRESHNESS_MARGIN_MS = 60_000;

/** Cancel handle returned by the injectable scheduler. */
type CancelTimer = () => void;

export interface CreateAppBridgeOptions {
    /**
     * Static allowlist of parent origins. Used as a fallback when the embed
     * URL does not carry a `parent_origin` query param. The first entry is
     * used as the dispatch target; the rest are reserved for future strict
     * matching.
     */
    allowedParentOrigins?: readonly string[];
    /**
     * Override the search string used to read signed params (defaults to
     * `window.location.search`). Intended for tests.
     */
    search?: string;
    /**
     * Override the parent window (defaults to `window.parent`). Intended for
     * tests.
     */
    parent?: Window;
    /** Tune or disable the automatic GET retry. */
    retry?: Partial<RetryPolicy>;
    /** How long to wait for a TOKEN reply before failing the refresh. */
    tokenRefreshTimeoutMs?: number;
    /**
     * Hard-disable the direct API path even when the host announces it. An
     * escape hatch for debugging a CORS or token problem in production without
     * shipping a new app build.
     */
    disableDirectApi?: boolean;
    /** Clock seam. Tests inject a fake. */
    now?: () => number;
    /** Jitter seam. Tests inject a deterministic sequence. */
    random?: () => number;
    /** Timer seam. Returns a cancel handle. Tests run it synchronously. */
    schedule?: (fn: () => void, ms: number) => CancelTimer;
    /** `fetch` seam for the direct API path. */
    fetchImpl?: typeof fetch;
    /** `window.open` seam for {@link AppBridge.connectExternal}. */
    openWindow?: (url: string, target: string, features: string) => Window | null;
    /**
     * Envelope channel to stamp on outbound messages before CONTEXT arrives.
     * Normally unnecessary — the host declares it on CONTEXT.
     */
    channel?: string;
}

/** Options for {@link AppBridge.connectExternal}. */
export interface ConnectExternalOptions {
    /** Give up (and reject) after this long. Default 3 minutes. */
    timeoutMs?: number;
    /**
     * Origins the callback page may post from. Defaults to the app's OWN
     * origin — the callback page belongs to the app, never to the platform and
     * never to the third party.
     */
    allowedOrigins?: readonly string[];
    /** Popup geometry, passed through to `window.open`. */
    features?: string;
}

/** Result of an external-account connect popup. */
export interface ConnectExternalResult {
    connected: boolean;
    /** Anything the callback page attached alongside `connected`. */
    detail?: unknown;
}

/** Per-call options for {@link AppBridge.graphql}. */
export interface GraphqlOptions {
    /** Name the operation when the document declares more than one. */
    operationName?: string;
    /**
     * Override the idempotence guess. Undefined means "decide from the
     * document": a query with no mutation and no subscription is retried on
     * 429/503, anything else never is.
     */
    retry?: boolean;
}

/** Toast options when you need more than a variant. */
export interface ToastOptions {
    variant?: ToastVariant;
    action?: ToastAction;
}

export interface AppBridge {
    /** The resolved session context. Null until `ready()` settles. */
    readonly context: AppContext | null;
    /** What the HOST announced it can do. Empty object before CONTEXT. */
    readonly hostCapabilities: HostCapabilities;
    /** Resolves with the context once the parent posts CONTEXT. */
    ready: () => Promise<AppContext>;
    /** Show a toast in the parent shell, optionally with an action button. */
    toast: (message: string, variantOrOptions?: ToastVariant | ToastOptions) => void;
    /** Ask the parent to navigate to `href`. */
    navigate: (href: string) => void;
    /**
     * Publish the whole page chrome — breadcrumbs, bar actions, dirty state,
     * title — in one message. Replaces the deleted `setTitle()`.
     *
     * Throws `BridgeValidationError` when the payload exceeds a host cap,
     * because the host's own response to that is a silent whole-payload drop.
     */
    setPage: (page: SetPagePayload) => void;
    /** Toggle the host's progress bar under the command bar. */
    loading: (active: boolean) => void;
    /** Subscribe to command-bar action clicks. Returns an unsubscribe handle. */
    onAction: (listener: (id: string) => void) => () => void;
    /** Register sidebar navigation links the host should render. */
    setSidebarLinks: (links: SidebarLink[]) => void;
    /** Subscribe to host-driven navigation (merchant clicked a sidebar link). */
    onHostNavigate: (listener: (path: string) => void) => () => void;
    /**
     * The current session token, refreshed through the host when it is about
     * to expire. Concurrent callers share one in-flight refresh.
     */
    getSessionToken: () => Promise<string>;
    /**
     * Call the REST proxy at `/api/apps/proxy` over postMessage. The host
     * authenticates server-side under the merchant's session.
     */
    request: (input: RequestOptions) => Promise<ResponseResult>;
    /**
     * Run a GraphQL document DIRECTLY against the platform, skipping the
     * postMessage proxy entirely — no double serialisation, no host
     * main-thread hop, browser-native parallelism.
     *
     * Requires the host to have announced `capabilities.directApi`; rejects
     * with a clear error otherwise rather than posting to an endpoint that may
     * not accept it. There is deliberately no proxy fallback: the proxy speaks
     * REST over an allow-list and has no GraphQL path to fall back TO.
     */
    graphql: (
        query: string,
        variables?: Record<string, unknown>,
        options?: GraphqlOptions,
    ) => Promise<ResponseResult>;
    /**
     * Open an OAuth/consent popup on a THIRD-PARTY service and wait for the
     * app's own callback page to report completion. No platform involvement.
     */
    connectExternal: (url: string, options?: ConnectExternalOptions) => Promise<ConnectExternalResult>;
    /** Low-level message seam. See {@link BridgeChannel}. */
    readonly channel: BridgeChannel;
    /** Subscribe to a bridge event. Returns an unsubscribe handle. */
    on: (event: 'context' | 'ready' | 'destroy', listener: BridgeListener) => () => void;
    /** Tear down the transport and reject any in-flight requests. */
    destroy: () => void;

    /**
     * Installed by `@flashmandu/app-bridge/modal`. Undefined in the core
     * bundle — declared here only so `bridge.modal.message(...)` type-checks
     * after `attachModal(bridge)` without a cast at every call site.
     */
    modal?: ModalApi;
    /** Installed by `@flashmandu/app-bridge/modal`. See {@link AppBridge.modal}. */
    picker?: PickerApi;
}

/** Shape installed on `bridge.modal` by `attachModal`. Implemented in `modal.ts`. */
export interface ModalApi {
    message: (input: {
        title: string;
        body: string;
        confirmLabel?: string;
        cancelLabel?: string;
    }) => Promise<{ confirmed: boolean }>;
    route: (path: string) => Promise<{ confirmed: boolean }>;
    close: () => void;
}

/** Shape installed on `bridge.picker` by `attachModal`. Implemented in `modal.ts`. */
export type PickerApi = (input: {
    kind: PickerKind;
    multiple?: boolean;
    query?: string;
}) => Promise<{
    cancelled: boolean;
    selections: Array<{ id: string | number; label: string; thumbnail?: string; meta?: Record<string, unknown> }>;
    error?: string;
}>;

interface PendingRequest {
    resolve: (value: ProxyResponsePayload) => void;
    reject: (error: Error) => void;
}

/** One transport-level attempt, before the retry loop decides what to do. */
interface RawResult {
    status: number;
    body: unknown;
    retryAfter: number | null;
    remaining: number | null;
    limit: number | null;
    reset: number | null;
}

const defaultSchedule = (fn: () => void, ms: number): CancelTimer => {
    const handle = setTimeout(fn, ms);
    return () => clearTimeout(handle);
};

export function createAppBridge(opts: CreateAppBridgeOptions = {}): AppBridge {
    const search = opts.search ?? (typeof window !== 'undefined' ? window.location.search : '');
    const parent = opts.parent ?? (typeof window !== 'undefined' ? window.parent : null);
    const now = opts.now ?? (() => Date.now());
    const random = opts.random ?? Math.random;
    const schedule = opts.schedule ?? defaultSchedule;
    const tokenRefreshTimeoutMs = opts.tokenRefreshTimeoutMs ?? 10_000;
    const retryPolicy: RetryPolicy = { ...DEFAULT_RETRY_POLICY, ...opts.retry };

    const sessionToken = readQueryParam(search, 'session_token');
    const appId = readQueryParam(search, 'app_id');
    const profileIdRaw = readQueryParam(search, 'profile_id');
    const target = readQueryParam(search, 'target');

    const profileId: number | string | null = profileIdRaw === null
        ? null
        : (/^[0-9]+$/.test(profileIdRaw) ? Number(profileIdRaw) : profileIdRaw);

    const parentOrigin = resolveParentOrigin(search, opts.allowedParentOrigins);

    const listeners: Partial<Record<BridgeEventKey, Set<BridgeListener>>> = {};
    const pending = new Map<number, PendingRequest>();
    const inbound = new Map<string, Set<(payload: unknown) => void>>();

    let context: AppContext | null = null;
    let hostCapabilities: HostCapabilities = {};
    let directApiEndpoint = DEFAULT_DIRECT_API_ENDPOINT;
    /**
     * Opaque envelope channel. Echoed on every outbound message once the host
     * declares one, omitted entirely until then — see {@link BridgeMessage}.
     */
    let envelopeChannel: string | null = opts.channel ?? null;
    let readyPromise: Promise<AppContext> | null = null;
    let readyResolve: ((value: AppContext) => void) | null = null;
    let destroyed = false;

    /**
     * Token state. Seeded from the embed URL; `tokenExpiresAt` stays null until
     * a host tells us otherwise, and a null expiry means "cannot know it is
     * stale" — we return the cached token rather than refreshing on every call
     * against a host that does not send `expiresAt`.
     */
    let currentToken: string | null = sessionToken;
    let tokenExpiresAt: number | null = null;
    let inflightTokenRefresh: Promise<string> | null = null;
    const pendingTokens = new Map<number, {
        resolve: (token: string) => void;
        reject: (error: Error) => void;
        cancelTimer: CancelTimer;
    }>();

    const transport: Transport = parent === null
        ? stubTransport()
        : createBrowserTransport({
            onContext: (payload: ContextPayload) => {
                hostCapabilities = payload.capabilities ?? {};
                if (typeof payload.directApiEndpoint === 'string' && payload.directApiEndpoint !== '') {
                    directApiEndpoint = payload.directApiEndpoint;
                }
                if (typeof payload.channel === 'string' && payload.channel !== '') {
                    envelopeChannel = payload.channel;
                }
                const contextExpiry = parseExpiry(payload.expiresAt);
                if (contextExpiry !== null) {
                    tokenExpiresAt = contextExpiry;
                }
                context = {
                    origin: payload.origin,
                    token: currentToken,
                    appId,
                    profileId,
                    target,
                    scopes: payload.scopes ?? [],
                    locale: payload.locale ?? null,
                    tz: payload.tz ?? null,
                    expiresAt: contextExpiry,
                    hostCapabilities,
                };
                // Re-announce the CURRENT capability state the moment the host
                // declares itself ready. SET_CAPABILITIES is fire-and-forget,
                // so a host that wired its listener up late would otherwise
                // miss an announcement made on an early subscribe and fall back
                // to full-page navigation for the rest of the session, silently.
                // CONTEXT is the one point where the host is provably listening.
                //
                // Sent before the emits below so that any subscribe made from a
                // `ready` handler still produces its own transition
                // announcement rather than being folded into this one.
                announceCapabilities();

                readyResolve?.(context);
                emit('context', context);
                emit('ready', context);
            },
            onResponse: (response) => {
                const waiter = pending.get(response.id);
                if (waiter === undefined) {
                    return;
                }
                pending.delete(response.id);
                waiter.resolve(response);
            },
        }, parentOrigin, parent);

    /**
     * Stamp the opaque envelope channel onto every outbound message.
     *
     * Omitted entirely while the host has declared none, rather than sent as
     * `undefined` or `''`: an absent field and a field holding a wrong value
     * are very different things to a host that validates the envelope.
     */
    function sendEnvelope(message: BridgeMessage): void {
        if (envelopeChannel === null) {
            transport.send(message);
            return;
        }
        transport.send({ ...message, channel: envelopeChannel });
    }

    function sendReady(): void {
        sendEnvelope({
            type: MessageType.Ready,
            payload: {
                token: sessionToken ?? '',
                appId: appId ?? '',
                sdkVersion: transport.sdkVersion,
            },
        });
    }

    function emit(event: BridgeEventKey, payload: unknown): void {
        const set = listeners[event];
        if (set === undefined) {
            return;
        }
        for (const listener of set) {
            try {
                listener(payload);
            } catch {
                // A listener throwing must not break the bridge.
            }
        }
    }

    const hostNavListeners = new Set<(path: string) => void>();
    const actionListeners = new Set<(id: string) => void>();

    /**
     * Tell the host what the app has actually wired up.
     *
     * Announced on CHANGE, never on a timer and never at construction: a React
     * app subscribes in an effect after mount, so a boot-time announcement
     * would always claim the wrong thing. The host needs this because it cannot
     * probe — asking with a synthetic HOST_NAVIGATE would make the app route to
     * its own current path, which is a no-op in some routers and a scroll-reset
     * or refetch in others. So the app volunteers instead.
     *
     * The flags are derived from the live sets rather than tracked separately,
     * so the announcement cannot drift from reality.
     */
    function announceCapabilities(): void {
        sendEnvelope({
            type: MessageType.SetCapabilities,
            payload: {
                capabilities: {
                    hostNavigate: hostNavListeners.size > 0,
                    action: actionListeners.size > 0,
                },
            },
        });
    }

    function dispatchInbound(type: string, payload: unknown): void {
        const set = inbound.get(type);
        if (set === undefined) return;
        for (const handler of set) {
            try {
                handler(payload);
            } catch {
                // A listener throwing must not break the bridge.
            }
        }
    }

    /**
     * The inbound router.
     *
     * Every host→iframe message that is not CONTEXT or RESPONSE arrives here
     * off the raw `window` rather than through the transport, and every one of
     * them is held to the same gate: accepted only from the parent window, only
     * on the parent origin resolved at boot, and never when that origin is
     * unknown. Fail-closed — an unguarded listener here would be the weakest
     * door in the wall, since anything holding a handle to this window could
     * otherwise drive the app's router, click its buttons, or feed it a token.
     *
     * Payloads stay untrusted after the gate: HOST_NAVIGATE only ever yields an
     * app-relative path, ACTION only ever yields an id the app itself declared.
     */
    const onHostMessage = (event: MessageEvent): void => {
        if (destroyed) {
            return;
        }
        // Fail-closed: if no parent origin was resolved, accept nothing.
        if (parentOrigin === null || event.origin !== parentOrigin) {
            return;
        }
        // Only accept messages from the parent window.
        if (parent === null || event.source !== parent) {
            return;
        }
        const data = event.data as { type?: unknown; payload?: unknown } | null;
        if (typeof data?.type !== 'string') {
            return;
        }

        if (data.type === MessageType.HostNavigate) {
            handleHostNavigate(data.payload);
        } else if (data.type === MessageType.Action) {
            handleAction(data.payload);
        } else if (data.type === MessageType.Token) {
            handleToken(data.payload);
        }

        // Channel subscribers see everything that passed the gate, including
        // CONTEXT and RESPONSE — the modal/picker entry and the mock host are
        // built on this and must not need a second gate of their own.
        dispatchInbound(data.type, data.payload);
    };

    function handleHostNavigate(payload: unknown): void {
        const p = payload as { id?: unknown; path?: unknown } | undefined;
        // The host always numbers its navigations. A message without a usable
        // id is malformed, and is dropped exactly like a bad origin: inventing
        // an id here would hand the host an ack it cannot match, which is worse
        // than the silence it already knows how to recover from.
        const rawId: unknown = p?.id;
        if (typeof rawId !== 'number' || !Number.isInteger(rawId) || rawId < 0) {
            return;
        }
        const path = typeof p?.path === 'string' ? p.path : null;
        if (path === null || !isAppRelativePath(path)) {
            return;
        }
        // No subscriber means the app cannot route, however well-formed the
        // message was. Staying silent is the point: the host has already moved
        // the address bar and the active highlight, and a missing ack is how it
        // learns to undo that. Acking here would make an app that imported the
        // SDK but never called `onHostNavigate` indistinguishable from one that
        // navigated successfully.
        if (hostNavListeners.size === 0) {
            return;
        }
        for (const listener of hostNavListeners) {
            try {
                listener(path);
            } catch {
                // A listener throwing must not break the bridge.
            }
        }
        // `transport.send` targets the resolved parent origin explicitly. The
        // id is echoed verbatim — it is the host's, allocated from the host's
        // own counter, and is the only thing that distinguishes two rapid
        // navigations to the same path.
        sendEnvelope({
            type: MessageType.HostNavigateAck,
            payload: { id: rawId, path },
        });
    }

    function handleAction(payload: unknown): void {
        const id = (payload as ActionPayload | undefined)?.id;
        // Same shape rule the app had to satisfy to declare the button.
        if (typeof id !== 'string' || id === '' || id.length > 32) {
            return;
        }
        for (const listener of actionListeners) {
            try {
                listener(id);
            } catch {
                // A listener throwing must not break the bridge.
            }
        }
    }

    function handleToken(payload: unknown): void {
        const p = payload as Partial<TokenPayload> | undefined;
        if (p === undefined) return;
        // An id-less reply settles the single in-flight refresh: the host is
        // allowed to answer without correlation because only one refresh is
        // ever outstanding (single-flight is enforced on this side).
        const waiter = typeof p.id === 'number'
            ? pendingTokens.get(p.id)
            : firstPendingToken();
        if (waiter === undefined) return;
        if (typeof p.id === 'number') {
            pendingTokens.delete(p.id);
        } else {
            clearFirstPendingToken();
        }
        waiter.cancelTimer();

        if (typeof p.error === 'string' && p.error !== '') {
            waiter.reject(new Error(`Token refresh failed: ${p.error}`));
            return;
        }
        if (typeof p.token !== 'string' || p.token === '') {
            waiter.reject(new Error('Token refresh returned no token.'));
            return;
        }
        currentToken = p.token;
        // The host sends ISO-8601 here, passed through verbatim from the
        // refresh endpoint — NOT a ms epoch. Reading it as a number would leave
        // `tokenExpiresAt` null forever, which reads as "validity unknown" and
        // silently disables the 60s refresh threshold for the rest of the
        // session: every call would keep using a token until it hard-expired.
        tokenExpiresAt = parseExpiry(p.expiresAt);
        if (context !== null) {
            context = { ...context, token: currentToken, expiresAt: tokenExpiresAt };
        }
        waiter.resolve(p.token);
    }

    function firstPendingToken(): { resolve: (t: string) => void; reject: (e: Error) => void; cancelTimer: CancelTimer } | undefined {
        for (const [, waiter] of pendingTokens) return waiter;
        return undefined;
    }

    function clearFirstPendingToken(): void {
        for (const [key] of pendingTokens) {
            pendingTokens.delete(key);
            return;
        }
    }

    /** True while the cached token has more than the safety margin left. */
    function tokenIsFresh(): boolean {
        if (currentToken === null || currentToken === '') return false;
        if (tokenExpiresAt === null) return true;
        return tokenExpiresAt - now() > TOKEN_FRESHNESS_MARGIN_MS;
    }

    /**
     * Single-flight token refresh.
     *
     * The shared promise is stored BEFORE any await point, so two callers in
     * the same tick — the common case, since a page that mounts three widgets
     * fires three reads at once — provably observe the same object and produce
     * exactly one TOKEN_REFRESH on the wire.
     */
    function refreshToken(): Promise<string> {
        if (inflightTokenRefresh !== null) {
            return inflightTokenRefresh;
        }
        if (destroyed) {
            return Promise.reject(new Error('App bridge has been destroyed.'));
        }

        const id = transport.nextId();
        const promise = new Promise<string>((resolve, reject) => {
            // Register and send BEFORE arming the timeout. A host that answers
            // synchronously (the mock host, and a real host on a fast path)
            // would otherwise race a timer that had not been created yet, and
            // the arming order is the only thing that makes the fast answer
            // safe. Arming after also means a settled promise simply ignores
            // the later timer callback.
            pendingTokens.set(id, { resolve, reject, cancelTimer: () => {} });
            sendEnvelope({ type: MessageType.TokenRefresh, payload: { id } });

            const waiter = pendingTokens.get(id);
            if (waiter === undefined) {
                return; // Already answered synchronously. Nothing to time out.
            }
            waiter.cancelTimer = schedule(() => {
                pendingTokens.delete(id);
                reject(new Error('Token refresh timed out.'));
            }, tokenRefreshTimeoutMs);
        });

        inflightTokenRefresh = promise;
        const clear = (): void => {
            if (inflightTokenRefresh === promise) {
                inflightTokenRefresh = null;
            }
        };
        promise.then(clear, clear);
        return promise;
    }

    function getSessionToken(): Promise<string> {
        if (tokenIsFresh()) {
            return Promise.resolve(currentToken as string);
        }
        return refreshToken();
    }

    async function proxyAttempt(input: RequestOptions): Promise<RawResult> {
        const id = transport.nextId();
        const payload = await new Promise<ProxyResponsePayload>((resolve, reject) => {
            pending.set(id, { resolve, reject });
            sendEnvelope({
                type: MessageType.Request,
                payload: {
                    id,
                    method: input.method,
                    path: input.path,
                    body: input.body ?? null,
                },
            });
            // No transport-level timeout here by design: the host posts
            // a status 0 RESPONSE on network failure, which resolves this
            // promise. A hung parent is the app's call to handle.
        });

        return {
            status: payload.status,
            body: payload.body,
            retryAfter: parseRetryAfter(payload.retryAfter ?? null, now),
            remaining: parseRemaining(payload.remaining ?? null),
            limit: null,
            reset: null,
        };
    }

    /**
     * One direct GraphQL attempt (design §4.7).
     *
     * `POST {origin}/api/apps/graphql` with a REAL GraphQL body — `{ query,
     * variables }` — because that endpoint is a genuine GraphQL server, not a
     * same-origin twin of the REST proxy. This is why `graphql()` is a separate
     * method rather than a transport flag on `request()`: the two speak
     * different protocols, and pretending otherwise would put a proxy envelope
     * on the wire that the endpoint cannot parse.
     *
     * `credentials: 'omit'`: the short-TTL session token IS the authentication,
     * and the host answers `Access-Control-Allow-Credentials: false`. Sending
     * the merchant's cookie cross-origin would both fail CORS and make the
     * endpoint CSRF-reachable from any page the merchant has open.
     *
     * The app's long-lived `api_token` is REJECTED here — the host refuses it
     * whenever an `Origin` header is present, precisely so a browser can never
     * hold it. Only `getSessionToken()` output works from the iframe.
     */
    async function graphqlAttempt(
        query: string,
        variables: Record<string, unknown> | undefined,
        operationName: string | undefined,
    ): Promise<RawResult> {
        const fetchImpl = opts.fetchImpl ?? (typeof fetch !== 'undefined' ? fetch : undefined);
        if (fetchImpl === undefined) {
            throw new Error('bridge.graphql() needs a fetch implementation; none is available.');
        }
        const origin = context?.origin;
        if (origin === undefined || origin === '') {
            throw new Error('bridge.graphql() called before CONTEXT resolved the platform origin.');
        }

        const token = await getSessionToken();
        const url = joinOrigin(origin, directApiEndpoint);

        const body: Record<string, unknown> = { query };
        if (variables !== undefined) body.variables = variables;
        if (operationName !== undefined) body.operationName = operationName;

        let response: Response;
        try {
            response = await fetchImpl(url, {
                method: 'POST',
                credentials: 'omit',
                headers: {
                    'Content-Type': 'application/json',
                    Accept: 'application/json',
                    Authorization: `Bearer ${token}`,
                },
                body: JSON.stringify(body),
            });
        } catch {
            // Status 0 is the same "transport failure" signal the proxy path
            // uses, so callers have one shape to handle rather than two.
            return { status: 0, body: null, retryAfter: null, remaining: null, limit: null, reset: null };
        }

        let parsed: unknown = null;
        try {
            parsed = await response.json();
        } catch {
            parsed = null;
        }

        return {
            status: response.status,
            body: parsed,
            retryAfter: parseRetryAfter(headerOf(response, 'Retry-After'), now),
            remaining: parseRemaining(headerOf(response, 'X-RateLimit-Remaining')),
            limit: parseRemaining(headerOf(response, 'X-RateLimit-Limit')),
            reset: parseRemaining(headerOf(response, 'X-RateLimit-Reset')),
        };
    }

    /** Proxy `request()` with the GET-only retry policy applied. */
    async function requestWithRetry(input: RequestOptions): Promise<ResponseResult> {
        let attempt = 0;

        for (;;) {
            attempt += 1;
            const raw = await proxyAttempt(input);

            if (!shouldRetry(input.method, raw.status, attempt, retryPolicy, input.retry)) {
                return finalise(raw, attempt, 'proxy');
            }

            await sleep(backoffDelayMs(attempt, raw.retryAfter, retryPolicy, random));
            if (destroyed) {
                throw new Error('App bridge has been destroyed.');
            }
        }
    }

    async function graphqlWithRetry(
        query: string,
        variables: Record<string, unknown> | undefined,
        options: GraphqlOptions,
    ): Promise<ResponseResult> {
        // A GraphQL document is always an HTTP POST, so METHOD cannot decide
        // whether retrying is safe — the OPERATION has to. A document with no
        // mutation and no subscription in it is a pure read and is retried like
        // a GET; anything else is left alone, and the caller can still force it
        // with `retry: true` once it carries its own idempotency key.
        const idempotent = options.retry ?? isReadOnlyDocument(query);
        let attempt = 0;

        for (;;) {
            attempt += 1;
            const raw = await graphqlAttempt(query, variables, options.operationName);

            // `'POST'` here is the honest HTTP method; `idempotent` is what
            // actually decides, passed as the explicit override.
            if (!shouldRetry('POST', raw.status, attempt, retryPolicy, idempotent)) {
                return finalise(raw, attempt, 'direct');
            }

            await sleep(backoffDelayMs(attempt, raw.retryAfter, retryPolicy, random));
            if (destroyed) {
                throw new Error('App bridge has been destroyed.');
            }
        }
    }

    function finalise(raw: RawResult, attempts: number, mode: 'direct' | 'proxy'): ResponseResult {
        return {
            status: raw.status,
            body: raw.body,
            retryAfter: raw.retryAfter,
            remaining: raw.remaining,
            limit: raw.limit,
            reset: raw.reset,
            attempts,
            transport: mode,
        };
    }

    function sleep(ms: number): Promise<void> {
        return new Promise<void>((resolve) => {
            schedule(resolve, ms);
        });
    }

    if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
        window.addEventListener('message', onHostMessage);
    }

    // Fire READY immediately — the host responds with CONTEXT.
    sendReady();

    const channel: BridgeChannel = {
        post(type: string, payload?: unknown): void {
            sendEnvelope({ type, payload });
        },
        subscribe(type: string, handler: (payload: unknown) => void): () => void {
            const set = inbound.get(type) ?? new Set<(payload: unknown) => void>();
            set.add(handler);
            inbound.set(type, set);
            return () => {
                set.delete(handler);
                if (set.size === 0) inbound.delete(type);
            };
        },
        nextId(): number {
            return transport.nextId();
        },
    };

    return {
        get context(): AppContext | null {
            return context;
        },
        get hostCapabilities(): HostCapabilities {
            return hostCapabilities;
        },
        channel,
        ready(): Promise<AppContext> {
            if (readyPromise !== null) {
                return readyPromise;
            }
            readyPromise = new Promise<AppContext>((resolve, reject) => {
                if (destroyed) {
                    reject(new Error('App bridge has been destroyed.'));
                    return;
                }
                if (context !== null) {
                    resolve(context);
                    return;
                }
                readyResolve = resolve;
            });
            return readyPromise;
        },
        toast(message: string, variantOrOptions: ToastVariant | ToastOptions = 'default'): void {
            const options: ToastOptions = typeof variantOrOptions === 'string'
                ? { variant: variantOrOptions }
                : variantOrOptions;
            const payload: { message: string; variant: ToastVariant; action?: ToastAction } = {
                message,
                variant: options.variant ?? 'default',
            };
            if (options.action !== undefined) {
                // An action whose path the host would reject is worse than no
                // action: the toast renders a button that silently does
                // nothing. Drop the action, keep the message.
                if (
                    typeof options.action.label === 'string' &&
                    options.action.label !== '' &&
                    typeof options.action.path === 'string' &&
                    isHostNavigablePath(options.action.path)
                ) {
                    payload.action = { label: options.action.label, path: options.action.path };
                }
            }
            sendEnvelope({ type: MessageType.Toast, payload });
        },
        navigate(href: string): void {
            sendEnvelope({
                type: MessageType.Navigate,
                payload: { href },
            });
        },
        setPage(page: SetPagePayload): void {
            sendEnvelope({
                type: MessageType.SetPage,
                payload: normalisePageChrome(page),
            });
        },
        loading(active: boolean): void {
            sendEnvelope({
                type: MessageType.Loading,
                payload: { active: active === true },
            });
        },
        onAction(listener: (id: string) => void): () => void {
            const wasEmpty = actionListeners.size === 0;
            actionListeners.add(listener);
            if (wasEmpty) {
                announceCapabilities();
            }
            return (): void => {
                const removed = actionListeners.delete(listener);
                if (removed && actionListeners.size === 0) {
                    announceCapabilities();
                }
            };
        },
        setSidebarLinks(links: SidebarLink[]): void {
            sendEnvelope({
                type: MessageType.SetSidebarLinks,
                payload: { links },
            });
        },
        onHostNavigate(listener: (path: string) => void): () => void {
            const wasEmpty = hostNavListeners.size === 0;
            hostNavListeners.add(listener);
            // Only the transition matters. Announcing on every subscribe would
            // spam the host with news it already has.
            if (wasEmpty && hostNavListeners.size > 0) {
                announceCapabilities();
            }

            return (): void => {
                // `delete` reports whether it actually removed anything, so a
                // double-called unsubscribe cannot fire a second announcement.
                const removed = hostNavListeners.delete(listener);
                if (removed && hostNavListeners.size === 0) {
                    announceCapabilities();
                }
            };
        },
        getSessionToken,
        request(input: RequestOptions): Promise<ResponseResult> {
            if (destroyed) {
                return Promise.reject(new Error('App bridge has been destroyed.'));
            }
            return requestWithRetry(input);
        },
        graphql(
            query: string,
            variables?: Record<string, unknown>,
            options: GraphqlOptions = {},
        ): Promise<ResponseResult> {
            if (destroyed) {
                return Promise.reject(new Error('App bridge has been destroyed.'));
            }
            if (typeof query !== 'string' || query.trim() === '') {
                return Promise.reject(new Error('bridge.graphql() needs a non-empty query document.'));
            }
            if (opts.disableDirectApi === true) {
                return Promise.reject(
                    new Error('Direct API is disabled on this bridge (`disableDirectApi`).'),
                );
            }
            if (hostCapabilities.directApi !== true) {
                // Failing loudly beats a hopeful POST: without the announcement
                // the app's origin is very likely not on the endpoint's CORS
                // allow-list, and the browser would surface that as an opaque
                // network error with nothing pointing at the cause.
                return Promise.reject(
                    new Error(
                        'The host did not announce `capabilities.directApi`, so bridge.graphql() is ' +
                        'unavailable. Use bridge.request() for REST reads over the proxy.',
                    ),
                );
            }
            return graphqlWithRetry(query, variables, options);
        },
        connectExternal(url: string, options: ConnectExternalOptions = {}): Promise<ConnectExternalResult> {
            return connectExternal(url, options, opts.openWindow, schedule);
        },
        on(event: BridgeEventKey, listener: BridgeListener): () => void {
            const set = listeners[event] ?? new Set<BridgeListener>();
            set.add(listener);
            listeners[event] = set;
            return () => {
                set.delete(listener);
            };
        },
        destroy(): void {
            if (destroyed) {
                return;
            }
            destroyed = true;
            // Tearing the bridge down removes every host-navigate listener, so
            // the host is told the same way it would be told about an ordinary
            // unsubscribe — otherwise it would keep suppressing clicks for an
            // app that can no longer route. Sent before the transport closes.
            const hadCapabilities = hostNavListeners.size > 0 || actionListeners.size > 0;
            hostNavListeners.clear();
            actionListeners.clear();
            if (hadCapabilities) {
                announceCapabilities();
            }
            if (typeof window !== 'undefined' && typeof window.removeEventListener === 'function') {
                window.removeEventListener('message', onHostMessage);
            }
            transport.destroy();
            for (const [, waiter] of pending) {
                waiter.reject(new Error('App bridge has been destroyed.'));
            }
            pending.clear();
            for (const [, waiter] of pendingTokens) {
                waiter.cancelTimer();
                waiter.reject(new Error('App bridge has been destroyed.'));
            }
            pendingTokens.clear();
            inbound.clear();
            emit('destroy', null);
        },
    };
}

type BridgeEventKey = 'context' | 'ready' | 'destroy';

/**
 * Open a third-party consent popup and wait for the app's OWN callback page.
 *
 * The platform is not involved at any point, by design: the third party's
 * tokens never travel through a host postMessage, never land in a host log,
 * and never sit in the platform's database. The app's backend does the code
 * exchange on its own origin and its callback page reports completion to the
 * opener.
 *
 * The opener listener is gated on `event.source === popup` AND an origin
 * allowlist defaulting to the app's own origin — the popup navigates through
 * the third party's domain, and a consent page that decided to postMessage
 * something must not be able to fake a completion.
 */
function connectExternal(
    url: string,
    options: ConnectExternalOptions,
    openWindow: CreateAppBridgeOptions['openWindow'],
    schedule: (fn: () => void, ms: number) => CancelTimer,
): Promise<ConnectExternalResult> {
    const timeoutMs = options.timeoutMs ?? 180_000;
    const features = options.features ?? 'width=680,height=760,noopener=no,noreferrer=no';

    const open = openWindow ?? ((u: string, t: string, f: string): Window | null => {
        if (typeof window === 'undefined' || typeof window.open !== 'function') return null;
        return window.open(u, t, f);
    });

    const selfOrigin = typeof window !== 'undefined' && typeof window.location?.origin === 'string'
        ? window.location.origin
        : null;
    const allowed = options.allowedOrigins ?? (selfOrigin === null ? [] : [selfOrigin]);

    return new Promise<ConnectExternalResult>((resolve, reject) => {
        const opened = open(url, 'flashmandu-connect-external', features);
        if (opened === null || opened === undefined) {
            reject(new Error('Popup blocked. Ask the merchant to allow popups for this app.'));
            return;
        }
        const popup: Window = opened;

        let settled = false;
        let cancelTimeout: CancelTimer = () => {};
        let cancelPoll: CancelTimer = () => {};

        const cleanup = (): void => {
            settled = true;
            cancelTimeout();
            cancelPoll();
            if (typeof window !== 'undefined' && typeof window.removeEventListener === 'function') {
                window.removeEventListener('message', onMessage);
            }
        };

        function onMessage(event: MessageEvent): void {
            if (settled) return;
            if (event.source !== popup) return;
            if (allowed.length > 0 && !allowed.includes(event.origin)) return;

            const data = event.data as
                | { type?: unknown; payload?: { connected?: unknown; detail?: unknown }; connected?: unknown; detail?: unknown }
                | null;
            if (data === null || typeof data !== 'object') return;

            // Two accepted shapes. The docs tell app authors to post
            // `{ connected: true }`, which is the whole ceremony; the enveloped
            // form exists so a callback page that already speaks the bridge
            // envelope does not need a special case.
            const enveloped = data.type === 'FLASHMANDU_BRIDGE:EXTERNAL_RESULT' ? data.payload : undefined;
            const source = enveloped ?? data;
            if (typeof source?.connected !== 'boolean') return;

            cleanup();
            try {
                popup.close();
            } catch {
                // A popup that navigated cross-origin may refuse close(). Not fatal.
            }
            const result: ConnectExternalResult = { connected: source.connected };
            if (source.detail !== undefined) result.detail = source.detail;
            resolve(result);
        }

        if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
            window.addEventListener('message', onMessage);
        }

        cancelTimeout = schedule(() => {
            if (settled) return;
            cleanup();
            try {
                popup.close();
            } catch {
                // ignore
            }
            reject(new Error('Timed out waiting for the external connection to complete.'));
        }, timeoutMs);

        // A merchant who closes the popup has answered "no". Polling is the
        // only way to learn that: a cross-origin popup fires no event on close.
        const poll = (): void => {
            if (settled) return;
            let closed = false;
            try {
                closed = popup.closed === true;
            } catch {
                closed = false;
            }
            if (closed) {
                cleanup();
                reject(new Error('Popup closed before the connection completed.'));
                return;
            }
            cancelPoll = schedule(poll, 400);
        };
        cancelPoll = schedule(poll, 400);
    });
}

/**
 * Normalise an expiry to a ms epoch.
 *
 * Accepts ISO-8601 (what the host's TOKEN reply carries) and a numeric ms
 * epoch (what older CONTEXT payloads carry). Anything unparseable becomes
 * null, which the freshness check reads as "cannot know", not "expired" — a
 * garbled expiry must not put the SDK into a refresh loop.
 */
function parseExpiry(value: unknown): number | null {
    if (typeof value === 'number' && Number.isFinite(value)) {
        return value;
    }
    if (typeof value !== 'string' || value.trim() === '') {
        return null;
    }
    const at = Date.parse(value.trim());
    return Number.isNaN(at) ? null : at;
}

/**
 * True when a GraphQL document only reads, and may therefore be retried.
 *
 * Conservative by construction: the document must contain no `mutation` and no
 * `subscription` keyword ANYWHERE, not merely in its first operation, because a
 * multi-operation document sent with an `operationName` still ships the
 * mutation text and a wrong guess here would replay a write. String literals
 * containing the word "mutation" cost a pointless non-retry, which is the
 * failure direction worth having.
 */
function isReadOnlyDocument(query: string): boolean {
    return !/\b(mutation|subscription)\b/i.test(query);
}

/** Join an origin with an endpoint path without doubling or dropping a slash. */
function joinOrigin(origin: string, endpoint: string): string {
    if (/^https?:\/\//i.test(endpoint)) return endpoint;
    const base = origin.replace(/\/+$/, '');
    const path = endpoint.startsWith('/') ? endpoint : `/${endpoint}`;
    return `${base}${path}`;
}

/** Read a response header defensively — stubbed fetches often omit `headers`. */
function headerOf(response: Response, name: string): string | null {
    const headers = response.headers as Headers | undefined;
    if (headers === undefined || typeof headers.get !== 'function') return null;
    return headers.get(name);
}

/** Used when there is no `window.parent` (e.g. SSR, top-level). Fail-safe. */
function stubTransport(): Transport {
    return {
        parentOrigin: null,
        sdkVersion: '0.3.0',
        send: () => {},
        nextId: () => 0,
        destroy: () => {},
    };
}
