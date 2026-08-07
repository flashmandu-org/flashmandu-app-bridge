/**
 * Public App Bridge API.
 *
 * The embedded app holds a single `AppBridge` instance, awaited through
 * `ready()` for the parent's CONTEXT, then drives the platform through
 * `request()`, `toast()`, `navigate()`, and `setTitle()`. The bridge reads its
 * signed session params from `window.location.search` (the embed shell stamps
 * `session_token`, `app_id`, `profile_id`, `target`, `parent_origin`, …) and
 * posts `READY` to `window.parent` on construction.
 */

import {
    type AppContext,
    type BridgeListener,
    type ContextPayload,
    type RequestOptions,
    type ResponseResult,
    type SidebarLink,
    type ToastVariant,
} from './types.js';
import { MessageType } from './types.js';
import {
    createBrowserTransport,
    readQueryParam,
    resolveParentOrigin,
    type Transport,
} from './transport.js';

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
}

export interface AppBridge {
    /** The resolved session context. Null until `ready()` settles. */
    readonly context: AppContext | null;
    /** Resolves with the context once the parent posts CONTEXT. */
    ready: () => Promise<AppContext>;
    /** Show a toast in the parent shell. */
    toast: (message: string, variant?: ToastVariant) => void;
    /** Ask the parent to navigate to `href`. */
    navigate: (href: string) => void;
    /** Set the parent document's title. */
    setTitle: (title: string) => void;
    /** Register sidebar navigation links the host should render. */
    setSidebarLinks: (links: SidebarLink[]) => void;
    /** Subscribe to host-driven navigation (merchant clicked a sidebar link). */
    onHostNavigate: (listener: (path: string) => void) => () => void;
    /** Proxy a read call through `/api/apps/proxy` (host-side auth). */
    request: (input: RequestOptions) => Promise<ResponseResult>;
    /** Subscribe to a bridge event. Returns an unsubscribe handle. */
    on: (event: 'context' | 'ready' | 'destroy', listener: BridgeListener) => () => void;
    /** Tear down the transport and reject any in-flight requests. */
    destroy: () => void;
}

interface PendingRequest {
    resolve: (value: ResponseResult) => void;
    reject: (error: Error) => void;
}

export function createAppBridge(opts: CreateAppBridgeOptions = {}): AppBridge {
    const search = opts.search ?? (typeof window !== 'undefined' ? window.location.search : '');
    const parent = opts.parent ?? (typeof window !== 'undefined' ? window.parent : null);

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

    let context: AppContext | null = null;
    let readyPromise: Promise<AppContext> | null = null;
    let readyResolve: ((value: AppContext) => void) | null = null;
    let destroyed = false;

    const transport: Transport = parent === null
        ? stubTransport()
        : createBrowserTransport({
            onContext: (payload: ContextPayload) => {
                context = {
                    origin: payload.origin,
                    token: sessionToken,
                    appId,
                    profileId,
                    target,
                    scopes: payload.scopes ?? [],
                    locale: payload.locale ?? null,
                    tz: payload.tz ?? null,
                    expiresAt: payload.expiresAt ?? null,
                };
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
                waiter.resolve({ status: response.status, body: response.body });
            },
        }, parentOrigin, parent);

    function sendReady(): void {
        transport.send({
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

    /**
     * HOST_NAVIGATE arrives off the raw `window` rather than through the
     * transport, but it is held to the same gate: it is accepted only from the
     * parent window, only on the parent origin resolved at boot, and never when
     * that origin is unknown. Fail-closed — an unguarded listener here would be
     * the weakest door in the wall, since anything holding a handle to this
     * window could otherwise drive the app's router.
     *
     * The payload itself is untrusted regardless: only an app-relative path is
     * ever handed to a listener.
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
        const data = event.data as { type?: string; payload?: { path?: unknown } } | null;
        if (data?.type !== MessageType.HostNavigate) {
            return;
        }
        const path = typeof data.payload?.path === 'string' ? data.payload.path : null;
        if (path === null || !isAppRelativePath(path)) {
            return;
        }
        for (const listener of hostNavListeners) {
            try {
                listener(path);
            } catch {
                // A listener throwing must not break the bridge.
            }
        }
    };

    if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
        window.addEventListener('message', onHostMessage);
    }

    // Fire READY immediately — the host responds with CONTEXT.
    sendReady();

    return {
        get context(): AppContext | null {
            return context;
        },
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
        toast(message: string, variant: ToastVariant = 'default'): void {
            transport.send({
                type: MessageType.Toast,
                payload: { message, variant },
            });
        },
        navigate(href: string): void {
            transport.send({
                type: MessageType.Navigate,
                payload: { href },
            });
        },
        setTitle(title: string): void {
            transport.send({
                type: MessageType.SetTitle,
                payload: { title },
            });
        },
        setSidebarLinks(links: SidebarLink[]): void {
            transport.send({
                type: MessageType.SetSidebarLinks,
                payload: { links },
            });
        },
        onHostNavigate(listener: (path: string) => void): () => void {
            hostNavListeners.add(listener);

            return (): void => {
                hostNavListeners.delete(listener);
            };
        },
        request(input: RequestOptions): Promise<ResponseResult> {
            if (destroyed) {
                return Promise.reject(new Error('App bridge has been destroyed.'));
            }
            const id = transport.nextId();
            return new Promise<ResponseResult>((resolve, reject) => {
                pending.set(id, { resolve, reject });

                transport.send({
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
            hostNavListeners.clear();
            if (typeof window !== 'undefined' && typeof window.removeEventListener === 'function') {
                window.removeEventListener('message', onHostMessage);
            }
            transport.destroy();
            for (const [, waiter] of pending) {
                waiter.reject(new Error('App bridge has been destroyed.'));
            }
            pending.clear();
            emit('destroy', null);
        },
    };
}

type BridgeEventKey = 'context' | 'ready' | 'destroy';

/**
 * True only for a path the app can safely route to itself. `//host` and `/\host`
 * both start with a slash yet are read as protocol-relative URLs by browsers and
 * by router `push()` calls, so they are rejected alongside absolute URLs.
 */
function isAppRelativePath(path: string): boolean {
    return path.startsWith('/') && !path.startsWith('//') && !path.startsWith('/\\');
}

/** Used when there is no `window.parent` (e.g. SSR, top-level). Fail-safe. */
function stubTransport(): Transport {
    return {
        parentOrigin: null,
        sdkVersion: '0.1.0',
        send: () => {},
        nextId: () => 0,
        destroy: () => {},
    };
}
