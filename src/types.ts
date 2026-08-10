/**
 * Typed message contracts for the Flashmandu App Bridge (protocol v2).
 *
 * These shapes MUST match the host-side counterpart at
 * `packages/flashmandu/apps/resources/js/app-bridge-host.ts` in the platform
 * repo. The host is the source of truth: message `type` strings and payload
 * field names are mirrored here verbatim. Do not rename anything here without
 * changing the host first — a mismatch silently breaks the bridge.
 *
 * The one exception to "host first" is a message this SDK introduces ahead of
 * the host implementation. Those are marked `@protocol-proposal` below; the
 * host must adopt the shape verbatim, and until it does the SDK degrades to
 * a rejected promise or a dropped fire-and-forget message — never a crash.
 *
 * Wire format (postMessage `data`): `{ type: string, payload?: ... }`.
 *
 * Protocol v2 has NO backwards compatibility with v1: `SET_TITLE` is deleted
 * outright, folded into `SET_PAGE.title`.
 */

/** Inbound (parent → iframe) and outbound (iframe → parent) message envelope. */
export interface BridgeMessage<P = unknown> {
    type: string;
    payload?: P;
    /**
     * Optional envelope channel, echoed from `CONTEXT.channel`.
     *
     * @protocol-proposal The host's SET_PAGE envelope is documented as
     * `{ type, channel, payload }` but no VALUE for `channel` was specified,
     * and host→iframe messages (ACTION, HOST_NAVIGATE) explicitly carry none.
     * The SDK therefore treats it as opaque pass-through: whatever the host
     * puts in `CONTEXT.channel` is echoed on iframe→host messages, and the
     * field is omitted entirely when the host declares nothing. A host that
     * needs a channel value only has to announce it.
     */
    channel?: string;
}

/** Message type constants. Kept as `const` so the literal types flow through. */
export const MessageType = {
    /** iframe → parent. Sent once on boot to request the session context. */
    Ready: 'FLASHMANDU_BRIDGE:READY',
    /** parent → iframe. Session context for the embedded app. */
    Context: 'FLASHMANDU_BRIDGE:CONTEXT',
    /** iframe → parent. A proxied API call through `/api/apps/proxy`. */
    Request: 'FLASHMANDU_BRIDGE:REQUEST',
    /** parent → iframe. The proxied API response, correlated by `id`. */
    Response: 'FLASHMANDU_BRIDGE:RESPONSE',
    /** iframe → parent. Toast notification (optionally with an action button). */
    Toast: 'FLASHMANDU_BRIDGE:TOAST',
    /** iframe → parent. Navigation request. */
    Navigate: 'FLASHMANDU_BRIDGE:NAVIGATE',
    /**
     * iframe → parent. The whole page chrome in one message: breadcrumbs, bar
     * actions, dirty state, document title. Replaces the deleted `SET_TITLE`.
     */
    SetPage: 'FLASHMANDU_BRIDGE:SET_PAGE',
    /** parent → iframe. The merchant clicked one of the app's bar actions. */
    Action: 'FLASHMANDU_BRIDGE:ACTION',
    /** iframe → parent. Toggle the host's indeterminate progress bar. */
    Loading: 'FLASHMANDU_BRIDGE:LOADING',
    /** iframe → parent. Register sidebar navigation links for the app. */
    SetSidebarLinks: 'FLASHMANDU_BRIDGE:SET_SIDEBAR_LINKS',
    /** parent → iframe. The merchant clicked one of the app's sidebar links. */
    HostNavigate: 'FLASHMANDU_BRIDGE:HOST_NAVIGATE',
    /** iframe → parent. A HOST_NAVIGATE reached an app listener. */
    HostNavigateAck: 'FLASHMANDU_BRIDGE:HOST_NAVIGATE_ACK',
    /** iframe → parent. Which bridge capabilities the app has wired up. */
    SetCapabilities: 'FLASHMANDU_BRIDGE:SET_CAPABILITIES',
    /** iframe → parent. Ask for a freshly minted short-TTL session token. */
    TokenRefresh: 'FLASHMANDU_BRIDGE:TOKEN_REFRESH',
    /**
     * parent → iframe. The freshly minted token, correlated by `id`.
     *
     * @protocol-proposal The design spec (§4.6) names only `TOKEN_REFRESH` and
     * says the host "posts it back" without naming the reply. This is the SDK's
     * chosen reply type; the host must use it verbatim.
     */
    Token: 'FLASHMANDU_BRIDGE:TOKEN',
    /** iframe → parent. Open a host-rendered modal (message or route mode). */
    ModalOpen: 'FLASHMANDU_BRIDGE:MODAL_OPEN',
    /** iframe → parent. Tear the current modal down without a result. */
    ModalClose: 'FLASHMANDU_BRIDGE:MODAL_CLOSE',
    /** parent → iframe. The modal settled. */
    ModalResult: 'FLASHMANDU_BRIDGE:MODAL_RESULT',
    /** iframe → parent. Open the host's resource picker. */
    PickerOpen: 'FLASHMANDU_BRIDGE:PICKER_OPEN',
    /** parent → iframe. The picker settled. */
    PickerResult: 'FLASHMANDU_BRIDGE:PICKER_RESULT',
} as const;

export type MessageTypeValue = (typeof MessageType)[keyof typeof MessageType];

/** READY payload (iframe → parent). */
export interface ReadyPayload {
    /** Signed session token from the embed URL (session_token query param). */
    token: string;
    /** App id from the embed URL (app_id query param). */
    appId: string;
    /** SDK version, sent for diagnostics + capability gating on the host. */
    sdkVersion: string;
}

/**
 * What the HOST can do, announced on CONTEXT.
 *
 * Distinct from {@link BridgeCapabilities}, which travels the other way and
 * says what the APP wired up. Absent field = "not available", which is what an
 * older host's silence already means.
 */
export interface HostCapabilities {
    /**
     * The host exposes a CORS-allowlisted GraphQL endpoint the iframe may
     * `fetch` itself with a short-TTL bearer token, skipping the postMessage
     * proxy (design §4.7). Gates `bridge.graphql()`; the REST `request()`
     * proxy is unaffected. See {@link ContextPayload.directApiEndpoint}.
     */
    directApi?: boolean;
    /** Host renders MODAL_OPEN (message + route modes). */
    modal?: boolean;
    /** Host renders PICKER_OPEN. */
    picker?: boolean;
    /** Host answers TOKEN_REFRESH with a freshly minted token. */
    tokenRefresh?: boolean;
    /** Host draws the LOADING progress bar. */
    loading?: boolean;
}

/**
 * CONTEXT payload (parent → iframe).
 *
 * The host historically posted only `{ origin }`. Every other field is
 * optional so the SDK reads richer contexts as newer hosts ship them without
 * breaking against an older one.
 */
export interface ContextPayload {
    /** Platform origin (e.g. `https://merchant.flashmandu.com`). */
    origin: string;
    profile?: number | string;
    locale?: string;
    tz?: string;
    scopes?: readonly string[];
    target?: string;
    /**
     * Session-token expiry. Drives the 60s refresh threshold (§4.6).
     * Accepted as ISO-8601 or as a numeric ms epoch.
     */
    expiresAt?: number | string;
    /** What the host supports. Absent = an older host that supports none of it. */
    capabilities?: HostCapabilities;
    /** Opaque envelope channel to echo on outbound messages. See BridgeMessage. */
    channel?: string;
    /**
     * Path of the direct API endpoint, resolved against `origin`.
     *
     * Design §4.7 fixes this at `/api/apps/graphql`, which is the default.
     * Making it host-declared costs nothing and stops the SDK from pinning a
     * route the platform may version.
     */
    directApiEndpoint?: string;
}

/** Toast variant. Host maps this to a Livewire dispatch + UI toast kind. */
export type ToastVariant = 'default' | 'success' | 'error' | 'warning' | 'info';

/** A button rendered inside the toast. Clicking it runs the HOST_NAVIGATE flow. */
export interface ToastAction {
    label: string;
    /** App-relative path. Must match the host's `APP_PATH_PATTERN`. */
    path: string;
}

/** TOAST payload (iframe → parent). `variant` mirrors the host field name. */
export interface ToastPayload {
    message: string;
    variant?: ToastVariant;
    /** Optional action button (design §4.9). */
    action?: ToastAction;
}

/** NAVIGATE payload (iframe → parent). `href` mirrors the host field name. */
export interface NavigatePayload {
    /** Absolute or path-relative URL the host should navigate to. */
    href: string;
}

/** One breadcrumb in the host command bar. The last entry is the current page. */
export interface PageCrumb {
    label: string;
    /** App-relative path. Omitted on the current (last) crumb. */
    path?: string;
}

/** Visual weight of a command-bar action. Mirrors the host's button variants. */
export type PageActionVariant = 'primary' | 'ghost' | 'danger';

/** One command-bar action button owned by the app. */
export interface PageAction {
    /** Stable id echoed back in ACTION. `[A-Za-z0-9_-]{1,32}`. */
    id: string;
    /** Button label, max 48 chars. */
    label: string;
    variant: PageActionVariant;
    /** Icon name from the host allow-list. Unknown names render no icon. */
    icon?: string;
    disabled?: boolean;
    /** Spinner state. The app re-sends SET_PAGE with this true while saving. */
    loading?: boolean;
}

/**
 * SET_PAGE payload (iframe → parent) — the whole page chrome, one message.
 *
 * Caps (host drops the payload WHOLE when exceeded — it cannot trust a partial
 * chrome): 5 crumbs, 4 actions, 48-char labels, 32-char action ids.
 */
export interface SetPagePayload {
    /** Document-title suffix only. The host owns the rest of the title. */
    title?: string;
    crumbs: PageCrumb[];
    actions: PageAction[];
    /** Flips the host's command-bar dirty state (hides ⌘K, shows Save/Discard). */
    dirty: boolean;
}

/** ACTION payload (parent → iframe). */
export interface ActionPayload {
    /** The `id` of the {@link PageAction} the merchant clicked. */
    id: string;
}

/** LOADING payload (iframe → parent). */
export interface LoadingPayload {
    active: boolean;
}

/** A single sidebar navigation link declared by the app. */
export interface SidebarLink {
    /** Display label shown in the sidebar. */
    label: string;
    /** Path within the app (e.g. `/maps`, `/maps/new`). */
    path: string;
    /** Optional icon name (Tabler icon or similar). */
    icon?: string;
}

/** SET_SIDEBAR_LINKS payload (iframe → parent). */
export interface SetSidebarLinksPayload {
    links: SidebarLink[];
}

/**
 * HOST_NAVIGATE payload (parent → iframe).
 *
 * `id` comes from the HOST's own counter — it is not related to the REQUEST
 * sequence — and is echoed back in the ack so the host can tell two rapid
 * navigations apart even when both name the same path. A message without a
 * numeric `id` is malformed and is dropped.
 */
export interface HostNavigatePayload {
    /** Host-allocated correlation id. Echoed verbatim in HOST_NAVIGATE_ACK. */
    id: number;
    /** App-relative path the merchant asked for, always leading-slashed. */
    path: string;
}

/**
 * HOST_NAVIGATE_ACK payload (iframe → parent).
 *
 * Sent only when a HOST_NAVIGATE passed every gate AND at least one app
 * listener was invoked with it. Silence means the app did not route: the host
 * must treat a missing ack as a failed navigation and recover (it has already
 * moved the address bar and the active highlight by then).
 */
export interface HostNavigateAckPayload {
    /** The `id` from the HOST_NAVIGATE, echoed verbatim. The host matches on this. */
    id: number;
    /** The accepted path, echoed back for debugging. Not the correlation key. */
    path: string;
}

/**
 * What the app has actually wired up, as opposed to what its SDK version could
 * in principle support.
 *
 * An object rather than a bare flag on purpose: the next capability must not
 * need a new message type. Every field is optional from the host's point of
 * view — an absent field means "not supported", which is the same thing an
 * older SDK's total silence means.
 */
export interface BridgeCapabilities {
    /**
     * True once at least one `onHostNavigate` listener is registered. The host
     * uses this to decide whether it may suppress a sidebar click at all: with
     * no announcement it must let the click perform an ordinary full-page
     * navigation.
     */
    hostNavigate: boolean;
    /**
     * True once at least one `onAction` listener is registered. The host uses
     * this to decide whether a SET_PAGE action button may be rendered at all —
     * a button nobody is listening to is a dead button.
     */
    action: boolean;
}

/**
 * SET_CAPABILITIES payload (iframe → parent).
 *
 * Sent when the app's capability set CHANGES — on the first `onHostNavigate`
 * subscribe, and again when the last one is removed. Never sent at
 * construction: a React app subscribes in an effect after mount, so an
 * announcement at boot would always claim the wrong thing.
 */
export interface SetCapabilitiesPayload {
    capabilities: BridgeCapabilities;
}

/** TOKEN_REFRESH payload (iframe → parent). `id` correlates the TOKEN reply. */
export interface TokenRefreshPayload {
    id: number;
}

/**
 * TOKEN payload (parent → iframe).
 *
 * @protocol-proposal see {@link MessageType.Token}. `error` lets the host fail
 * a refresh explicitly instead of leaving the SDK on its timeout.
 */
export interface TokenPayload {
    id: number;
    token: string;
    /**
     * New expiry as **ISO-8601**, passed through verbatim from the host's
     * refresh endpoint. A numeric ms epoch is also accepted. Absent or
     * unparseable means "unknown", which disables the threshold rather than
     * forcing a refresh on every call.
     */
    expiresAt?: string | number;
    /**
     * Terminal failure code. All of these mean STOP, never retry:
     * `refresh_failed_401|403|404|419|429`, `refresh_malformed`,
     * `network_error`, `unknown_app`.
     */
    error?: string;
}

/** Modal content modes (design §4.4). */
export type ModalMode = 'message' | 'route';

/** Confirm-button treatment for a `message` modal. */
export type ModalVariant = 'default' | 'danger';

/**
 * MODAL_OPEN payload (iframe → parent).
 *
 * @protocol-proposal the `id` correlation field. §4.4 allows only one modal at
 * a time, so the host COULD reply without one; the SDK sends it anyway and
 * accepts a reply with or without a matching id (an id-less reply settles the
 * single in-flight modal). Host agents may ignore `id` safely.
 */
export interface ModalOpenPayload {
    id: number;
    mode: ModalMode;
    /** `message` mode: max 80 chars. */
    title?: string;
    /** `message` mode: max 500 chars. */
    body?: string;
    /** `message` mode: max 32 chars. */
    confirmLabel?: string;
    /** `message` mode: max 32 chars. */
    cancelLabel?: string;
    /**
     * `message` mode: `danger` renders the confirm button destructively.
     *
     * The host has always read this (`_bridge-host-overlays.blade.php` binds
     * `variant === 'danger'` onto the confirm button); it was simply
     * unreachable from the SDK until 0.3, so every app's delete dialog looked
     * like a neutral one. Omitted means `default`.
     */
    variant?: ModalVariant;
    /** `route` mode: app-relative path opened in the host's max-modal. */
    path?: string;
}

/** MODAL_CLOSE payload (iframe → parent). */
export interface ModalClosePayload {
    id?: number;
}

/** MODAL_RESULT payload (parent → iframe). */
export interface ModalResultPayload {
    id?: number;
    confirmed: boolean;
    /** Set when the host refused to open (e.g. a modal is already up). */
    error?: string;
}

/** Resource kinds the host picker can serve. P0: item, media. */
export type PickerKind = 'item' | 'media';

/** PICKER_OPEN payload (iframe → parent). `id` correlation as per MODAL_OPEN. */
export interface PickerOpenPayload {
    id: number;
    kind: PickerKind;
    multiple?: boolean;
    /** Pre-seeded search term. */
    query?: string;
}

/** One picked resource. A summary, never a full model. */
export interface PickerSelection {
    id: string | number;
    label: string;
    thumbnail?: string;
    meta?: Record<string, unknown>;
}

/** PICKER_RESULT payload (parent → iframe). */
export interface PickerResultPayload {
    id?: number;
    cancelled: boolean;
    selections: PickerSelection[];
    /** `'scope'` when the app lacks the scope the kind requires. */
    error?: string;
}

/** HTTP methods the proxy endpoint allows (see BridgeProxyController). */
export type ProxyMethod = 'GET' | 'POST';

/** REQUEST payload (iframe → parent). `id` correlates the matching RESPONSE. */
export interface ProxyRequestPayload {
    id: number;
    method: ProxyMethod;
    path: string;
    body?: Record<string, unknown> | null;
}

/**
 * RESPONSE payload (parent → iframe). status 0 means transport failure.
 *
 * @protocol-proposal `retryAfter` / `remaining`. Design §4.8 requires rate-limit
 * info on the result; over the proxy the host is the only thing that sees the
 * response headers, so it must forward them. Both are optional — an older host
 * that omits them yields `null` on the result, not an error.
 */
export interface ProxyResponsePayload {
    id: number;
    status: number;
    body: unknown;
    /** `Retry-After` in SECONDS, parsed host-side. */
    retryAfter?: number | null;
    /** `X-RateLimit-Remaining`. */
    remaining?: number | null;
}

/** Resolved session context, exposed to the app after `ready()` settles. */
export interface AppContext {
    /** Platform origin the iframe is bridging into. */
    origin: string;
    /** Signed session token from the embed URL, if present. */
    token: string | null;
    /** App id from the embed URL, if present. */
    appId: string | null;
    /** Profile id from the embed URL, if present. */
    profileId: number | string | null;
    /** The embed target (which surface the iframe is mounted in). */
    target: string | null;
    /** Granted OAuth scopes, when the host forwards them. */
    scopes: readonly string[];
    /** Locale string forwarded by the host, if any. */
    locale: string | null;
    /** Time zone forwarded by the host, if any. */
    tz: string | null;
    /** Context expiry (ms epoch), when forwarded by the host. */
    expiresAt: number | null;
    /** What the HOST announced it can do. Never a promise about the app. */
    hostCapabilities: HostCapabilities;
}

/** Public events the app can subscribe to via `on()`. */
export type BridgeEventName =
    | 'context'
    | 'ready'
    | 'destroy';

/** Generic event listener. */
export type BridgeListener = (payload: unknown) => void;

/** Public `request()` input. */
export interface RequestOptions {
    method: ProxyMethod;
    /** Path on the proxy (e.g. `orders`, `catalog/items`). Leading `/` ok. */
    path: string;
    body?: Record<string, unknown> | null;
    /** Opt a GET out of the automatic retry, or opt a POST in (at your risk). */
    retry?: boolean;
}

/**
 * Result of `request()` and `graphql()`. body is `unknown` — callers
 * assert/cast. For `graphql()` it is the whole GraphQL envelope
 * (`{ data, errors }`), never just `data`: a partial success carries both, and
 * unwrapping here would silently throw half the answer away.
 *
 * Rate fields are populated from `X-RateLimit-*` / `Retry-After` on the direct
 * transport (the host exposes them via CORS so they are readable
 * cross-origin), and from the host-forwarded RESPONSE payload on the proxy.
 * `limit` and `reset` are direct-only — the proxy does not forward them.
 */
export interface ResponseResult {
    status: number;
    body: unknown;
    /** Seconds the caller should wait before retrying, when the host said so. */
    retryAfter: number | null;
    /** `X-RateLimit-Remaining`: requests left in the current window. */
    remaining: number | null;
    /** `X-RateLimit-Limit`: window size. Direct transport only. */
    limit: number | null;
    /** `X-RateLimit-Reset`: when the window reopens. Direct transport only. */
    reset: number | null;
    /** How many attempts it took (1 = no retry). */
    attempts: number;
    /** Which path the call actually took. */
    transport: 'direct' | 'proxy';
}

/**
 * Low-level escape hatch: post and subscribe to raw bridge messages.
 *
 * This is the seam the optional `/modal` entry and the `/testing` mock host are
 * built on, so that modal + picker can live outside the core bundle and
 * tree-shake away for apps that never touch them. App authors should not need
 * it, but it is public and supported — a new host message can be adopted from
 * userland without waiting for an SDK release.
 */
export interface BridgeChannel {
    /** Post a raw message to the parent, scoped to the resolved origin. */
    post: (type: string, payload?: unknown) => void;
    /**
     * Subscribe to a raw inbound message type. The listener only ever sees
     * messages that passed the origin + source gate.
     */
    subscribe: (type: string, handler: (payload: unknown) => void) => () => void;
    /** Allocate a correlation id from the same monotonic sequence as REQUEST. */
    nextId: () => number;
}
