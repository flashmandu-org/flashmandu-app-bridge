/**
 * postMessage transport for the App Bridge.
 *
 * Single channel: only messages from the parent window are accepted, and only
 * when `event.origin` matches the parent origin we resolved at boot. Outbound
 * REQUEST messages get a monotonic id so the higher layer can await the
 * matching RESPONSE by id.
 *
 * Origin resolution order (first non-empty wins):
 *   1. `parent_origin` query param (signed/published by the embed shell).
 *   2. `document.referrer` origin (best-effort for non-standard embeds).
 *   3. The first entry of `allowedParentOrigins` (if provided).
 *
 * If no origin can be resolved, the transport still constructs but refuses to
 * dispatch inbound messages — the bridge will never become `ready`. This is
 * fail-closed: rather than accept messages from any origin, we accept none.
 *
 * The window-attachment seam is exposed as `TransportDeps.attach`, so the
 * transport (and the bridge built on it) is fully testable without a real
 * browser: tests pass a direct `attach` that captures the listener.
 */

import {
    type BridgeMessage,
    type ContextPayload,
    MessageType,
    type ProxyResponsePayload,
} from './types.js';

const SDK_VERSION = '0.1.0';

/** Resolve the parent origin from the embed URL or a static allowlist. */
export function resolveParentOrigin(
    search: string,
    allowedOrigins?: readonly string[],
): string | null {
    const fromQuery = readQueryParam(search, 'parent_origin');
    if (fromQuery !== null) {
        return fromQuery;
    }

    if (typeof document !== 'undefined' && typeof document.referrer === 'string') {
        const refOrigin = originOf(document.referrer);
        if (refOrigin !== null) {
            return refOrigin;
        }
    }

    if (allowedOrigins !== undefined && allowedOrigins.length > 0) {
        return allowedOrigins[0] ?? null;
    }

    return null;
}

/**
 * The message-listener attachment seam. In the browser this is wired to
 * `window.addEventListener('message', ...)`. Tests pass a closure that
 * captures the listener so it can be invoked directly.
 */
export type AttachMessageListener = (listener: (event: MessageEvent) => void) => () => void;

export interface TransportDeps {
    /** The parent window to postMessage to. */
    parent: Window;
    /** Attach/detach the inbound message listener. */
    attach: AttachMessageListener;
}

export interface TransportHandlers {
    onContext: (payload: ContextPayload) => void;
    onResponse: (response: ProxyResponsePayload) => void;
}

export interface Transport {
    /** The resolved parent origin (null if none could be determined). */
    readonly parentOrigin: string | null;
    /** SDK version stamp, attached to outbound READY messages. */
    readonly sdkVersion: string;
    /** Send a typed message to the parent window. No-op if origin is unknown. */
    send: (message: BridgeMessage) => void;
    /** Allocate the next monotonic id for REQUEST correlation. */
    nextId: () => number;
    /** Detach the message listener. Safe to call multiple times. */
    destroy: () => void;
}

/** Browser default attachment: hooks `window` if present. */
const browserAttach: AttachMessageListener = (listener) => {
    if (typeof window === 'undefined' || typeof window.addEventListener !== 'function') {
        return () => {};
    }
    window.addEventListener('message', listener);
    return () => {
        if (typeof window.removeEventListener === 'function') {
            window.removeEventListener('message', listener);
        }
    };
};

export function createTransport(
    handlers: TransportHandlers,
    parentOrigin: string | null,
    deps: TransportDeps,
): Transport {
    const { parent, attach } = deps;
    let detach = (): void => {};
    let destroyed = false;
    let seq = 0;
    let contextReceived = false;

    const onMessage = (event: MessageEvent): void => {
        if (destroyed) {
            return;
        }
        // Only accept messages from the parent window.
        if (event.source !== parent) {
            return;
        }
        // Fail-closed: if no origin was resolved, accept nothing.
        if (parentOrigin === null || event.origin !== parentOrigin) {
            return;
        }
        if (!isBridgeMessage(event.data)) {
            return;
        }

        const msg = event.data as BridgeMessage;
        if (msg.type === MessageType.Context) {
            const payload = (msg.payload ?? {}) as Partial<ContextPayload>;
            if (payload.origin === undefined || payload.origin === '') {
                return;
            }
            if (!contextReceived) {
                contextReceived = true;
                handlers.onContext(payload as ContextPayload);
            }
            return;
        }

        if (msg.type === MessageType.Response) {
            const response = msg.payload as unknown;
            if (isProxyResponse(response)) {
                handlers.onResponse(response);
            }
        }
    };

    detach = attach(onMessage);

    return {
        parentOrigin,
        sdkVersion: SDK_VERSION,
        send(message: BridgeMessage): void {
            if (destroyed || parentOrigin === null) {
                return;
            }
            // Always state the expected origin — postMessage with `*` leaks
            // the message to any frame that happens to be listening.
            parent.postMessage(message, parentOrigin);
        },
        nextId(): number {
            seq += 1;
            return seq;
        },
        destroy(): void {
            if (destroyed) {
                return;
            }
            destroyed = true;
            detach();
        },
    };
}

/** Convenience constructor that wires the browser-default attachment. */
export function createBrowserTransport(
    handlers: TransportHandlers,
    parentOrigin: string | null,
    parent: Window,
): Transport {
    return createTransport(handlers, parentOrigin, { parent, attach: browserAttach });
}

function isBridgeMessage(data: unknown): data is BridgeMessage {
    if (typeof data !== 'object' || data === null) {
        return false;
    }
    const candidate = data as Record<string, unknown>;
    return typeof candidate.type === 'string';
}

function isProxyResponse(payload: unknown): payload is ProxyResponsePayload {
    if (typeof payload !== 'object' || payload === null) {
        return false;
    }
    const candidate = payload as Record<string, unknown>;
    return (
        typeof candidate.id === 'number' &&
        typeof candidate.status === 'number'
    );
}

/** Read a single query param value from a `?a=1&b=2` style search string. */
export function readQueryParam(search: string, key: string): string | null {
    if (search === '' || typeof URLSearchParams === 'undefined') {
        return null;
    }
    const params = new URLSearchParams(search.startsWith('?') ? search.slice(1) : search);
    const value = params.get(key);
    return value !== null && value !== '' ? value : null;
}

/** Extract `${scheme}://${host}${port}` from a URL string, or null. */
function originOf(url: string): string | null {
    if (url === '' || typeof URL === 'undefined') {
        return null;
    }
    try {
        return new URL(url).origin;
    } catch {
        return null;
    }
}
