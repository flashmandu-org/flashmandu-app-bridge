/**
 * Typed message contracts for the Flashmandu App Bridge.
 *
 * These shapes MUST match the host-side counterpart at
 * `packages/flashmandu/apps/resources/js/app-bridge-host.ts` in the platform
 * repo. The host is the source of truth: message `type` strings and payload
 * field names are mirrored here verbatim. Do not rename anything here without
 * changing the host first — a mismatch silently breaks the bridge.
 *
 * Wire format (postMessage `data`): `{ type: string, payload?: ... }`.
 */

/** Inbound (parent → iframe) and outbound (iframe → parent) message envelope. */
export interface BridgeMessage<P = unknown> {
    type: string;
    payload?: P;
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
    /** iframe → parent. Toast notification. */
    Toast: 'FLASHMANDU_BRIDGE:TOAST',
    /** iframe → parent. Navigation request. */
    Navigate: 'FLASHMANDU_BRIDGE:NAVIGATE',
    /** iframe → parent. Set the embed shell's document title. */
    SetTitle: 'FLASHMANDU_BRIDGE:SET_TITLE',
    /** iframe → parent. Register sidebar navigation links for the app. */
    SetSidebarLinks: 'FLASHMANDU_BRIDGE:SET_SIDEBAR_LINKS',
    /** parent → iframe. The merchant clicked one of the app's sidebar links. */
    HostNavigate: 'FLASHMANDU_BRIDGE:HOST_NAVIGATE',
    /** iframe → parent. A HOST_NAVIGATE reached an app listener. */
    HostNavigateAck: 'FLASHMANDU_BRIDGE:HOST_NAVIGATE_ACK',
    /** iframe → parent. Which bridge capabilities the app has wired up. */
    SetCapabilities: 'FLASHMANDU_BRIDGE:SET_CAPABILITIES',
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
 * CONTEXT payload (parent → iframe).
 *
 * The host currently posts only `{ origin }` (the platform origin). The
 * additional fields are declared optional so the SDK can read them when newer
 * hosts ship the fuller context, without breaking against the current host.
 */
export interface ContextPayload {
    /** Platform origin (e.g. `https://merchant.flashmandu.com`). */
    origin: string;
    profile?: number | string;
    locale?: string;
    tz?: string;
    scopes?: readonly string[];
    target?: string;
    expiresAt?: number;
}

/** Toast variant. Host maps this to a Livewire dispatch + UI toast kind. */
export type ToastVariant = 'default' | 'success' | 'error' | 'warning' | 'info';

/** TOAST payload (iframe → parent). `variant` mirrors the host field name. */
export interface ToastPayload {
    message: string;
    variant?: ToastVariant;
}

/** NAVIGATE payload (iframe → parent). `href` mirrors the host field name. */
export interface NavigatePayload {
    /** Absolute or path-relative URL the host should navigate to. */
    href: string;
}

/** SET_TITLE payload (iframe → parent). */
export interface SetTitlePayload {
    title: string;
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

/** HTTP methods the proxy endpoint allows (see BridgeProxyController). */
export type ProxyMethod = 'GET' | 'POST';

/** REQUEST payload (iframe → parent). `id` correlates the matching RESPONSE. */
export interface ProxyRequestPayload {
    id: number;
    method: ProxyMethod;
    path: string;
    body?: Record<string, unknown> | null;
}

/** RESPONSE payload (parent → iframe). status 0 means transport failure. */
export interface ProxyResponsePayload {
    id: number;
    status: number;
    body: unknown;
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
}

/** Public `request()` result. body is `unknown` — callers assert/cast. */
export interface ResponseResult {
    status: number;
    body: unknown;
}
