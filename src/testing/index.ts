/**
 * `@flashmandu/app-bridge/testing` — an in-memory host for unit tests.
 *
 * Testing an embedded app normally means one of two bad options: mock
 * `window.postMessage` by hand in every spec, or boot a real platform. The
 * first re-implements the protocol (badly, and drifts), the second is not a
 * unit test. `createMockHost()` is the third option — a real implementation of
 * the host half of the protocol that lives in memory, answers READY with
 * CONTEXT, records everything the app posts, and lets a test script the host's
 * side of a flow:
 *
 * ```ts
 * import { createMockHost } from '@flashmandu/app-bridge/testing';
 *
 * const host = createMockHost();
 * const bridge = host.createBridge();
 *
 * bridge.setPage({ crumbs: [{ label: 'Maps' }], actions: [], dirty: false });
 * expect(host.lastPage()?.crumbs).toEqual([{ label: 'Maps' }]);
 *
 * bridge.onAction((id) => saved.push(id));
 * host.clickAction('save');
 * ```
 *
 * Shipped as its own entry so none of it reaches an app's production bundle.
 *
 * IMPLEMENTATION NOTE — everything is SYNCHRONOUS. The bridge registers each
 * correlation (`pending`, `pendingTokens`, the modal's `modalPending`) before
 * it posts, so a host that answers inside `postMessage` cannot answer too
 * early. That buys tests determinism with no fake timers and no `await tick()`.
 */

import { createAppBridge, type AppBridge, type CreateAppBridgeOptions } from '../app-bridge.js';
import {
    MessageType,
    type BridgeCapabilities,
    type ColorScheme,
    type HostCapabilities,
    type HostNavigateAckPayload,
    type LoadingPayload,
    type ModalOpenPayload,
    type NavigatePayload,
    type PickerOpenPayload,
    type PickerSelection,
    type ProxyRequestPayload,
    type SetPagePayload,
    type SetSidebarLinksPayload,
    type SidebarLink,
    type ToastPayload,
} from '../types.js';

/** One message the app posted to the host. */
export interface RecordedMessage {
    type: string;
    payload: unknown;
    targetOrigin: string;
    /** The opaque envelope channel, when the app stamped one. */
    channel?: string;
}

/** What a stubbed API call should answer with. */
export interface MockApiResponse {
    status: number;
    body?: unknown;
    /** `Retry-After`, in seconds. Forwarded on both transports. */
    retryAfter?: number | null;
    /** `X-RateLimit-Remaining`. */
    remaining?: number | null;
    /** `X-RateLimit-Limit`. Direct/GraphQL transport only. */
    limit?: number | null;
    /** `X-RateLimit-Reset`. Direct/GraphQL transport only. */
    reset?: number | null;
}

/** A GraphQL call arriving at the direct endpoint. */
export interface MockGraphqlCall {
    query: string;
    variables: Record<string, unknown> | null;
    operationName: string | null;
    /** Bearer token presented. The long-lived api_token must never appear here. */
    token: string | null;
    /** URL the app posted to. */
    url: string;
    /** 1-based attempt counter for this document, so retries are scriptable. */
    attempt: number;
}

export type MockGraphqlHandler = (call: MockGraphqlCall) => MockApiResponse;

/** The call a stub handler is answering. */
export interface MockApiCall {
    method: 'GET' | 'POST';
    path: string;
    body: Record<string, unknown> | null;
    /** Always `'proxy'` — REST calls only ever travel over postMessage. */
    transport: 'proxy';
    /** 1-based attempt counter for this path+method, so retries are scriptable. */
    attempt: number;
}

export type MockApiHandler = (call: MockApiCall) => MockApiResponse;

export interface CreateMockHostOptions {
    /** Platform origin the fake host lives on. */
    origin?: string;
    appId?: string;
    profileId?: number;
    /** Initial session token stamped into the embed URL. */
    token?: string;
    /** Session-token expiry announced on CONTEXT. ISO-8601 or ms epoch. */
    expiresAt?: number | string;
    scopes?: readonly string[];
    locale?: string;
    tz?: string;
    /** What this host claims it can do. Defaults to everything ON. */
    capabilities?: HostCapabilities;
    /** Opaque envelope channel announced on CONTEXT. Omitted when unset. */
    channel?: string;
    /**
     * Colour scheme announced on CONTEXT. Omitted when unset, which is how a
     * pre-0.3 host behaves — use that to test the OS fallback.
     */
    theme?: ColorScheme;
    /** Answer READY with CONTEXT automatically. Default true. */
    autoContext?: boolean;
    /** Default answer for any API call with no scripted handler. */
    defaultResponse?: MockApiResponse;
}

/** A popup opened by `bridge.connectExternal`. */
export interface MockPopup {
    url: string;
    closed: boolean;
    close: () => void;
}

export interface MockHost {
    readonly origin: string;
    /** The embed-URL search string. Pass to `createAppBridge({ search })`. */
    readonly search: string;
    /** Everything the app has posted, in order. */
    readonly sent: RecordedMessage[];
    /** The bridge created by {@link MockHost.createBridge}, if any. */
    readonly bridge: AppBridge | null;
    /** Popups opened via `connectExternal`, in order. */
    readonly popups: MockPopup[];
    /**
     * The direct GraphQL endpoint stub, as a `fetch`. Wired into every bridge
     * from {@link MockHost.createBridge}; exposed so a test can call the
     * endpoint directly and assert what it rejects.
     */
    readonly fetchImpl: typeof fetch;

    /** Build a bridge wired to this host. Options are merged over the defaults. */
    createBridge: (overrides?: Partial<CreateAppBridgeOptions>) => AppBridge;

    /** Every payload the app posted under `type`. */
    messagesOf: <T = unknown>(type: string) => T[];
    /** SET_PAGE payloads, in order. */
    pages: () => SetPagePayload[];
    /** The most recent SET_PAGE payload, or null. */
    lastPage: () => SetPagePayload | null;
    /** TOAST payloads, in order. */
    toasts: () => ToastPayload[];
    /** LOADING `active` flags, in order. */
    loadingStates: () => boolean[];
    /** NAVIGATE hrefs, in order. */
    navigations: () => string[];
    /** The most recent SET_SIDEBAR_LINKS list, or null. */
    sidebarLinks: () => SidebarLink[] | null;
    /** SET_CAPABILITIES announcements, in order. */
    announcements: () => BridgeCapabilities[];
    /** HOST_NAVIGATE_ACK payloads, in order. */
    acks: () => HostNavigateAckPayload[];
    /** MODAL_OPEN payloads, in order. */
    modalOpens: () => ModalOpenPayload[];
    /** PICKER_OPEN payloads, in order. */
    pickerOpens: () => PickerOpenPayload[];
    /** How many TOKEN_REFRESH messages have been sent. Proves single-flight. */
    tokenRefreshCount: () => number;

    /** Post a raw host→iframe message. */
    post: (type: string, payload?: unknown) => void;
    /** Send (or re-send) CONTEXT, optionally patching fields. */
    sendContext: (patch?: Partial<{
        origin: string;
        expiresAt: number | string;
        scopes: readonly string[];
        capabilities: HostCapabilities;
        directApiEndpoint: string;
        theme: ColorScheme;
    }>) => void;
    /** Simulate a merchant clicking a command-bar action. */
    clickAction: (id: string) => void;
    /**
     * Simulate the merchant toggling their admin theme mid-session, which the
     * real host answers with a THEME message.
     */
    setTheme: (theme: ColorScheme) => void;
    /** Simulate a sidebar click. Returns the host-allocated correlation id. */
    hostNavigate: (path: string) => number;

    /** Script API responses (both transports). Last registration wins. */
    onApiCall: (handler: MockApiHandler) => void;
    /** Answer one path with a fixed response. */
    stub: (method: 'GET' | 'POST', path: string, response: MockApiResponse) => void;
    /** Queue responses for successive calls to a path — for retry tests. */
    stubSequence: (method: 'GET' | 'POST', path: string, responses: MockApiResponse[]) => void;

    /** Answer every `bridge.graphql()` call. Default: `200 { data: {} }`. */
    onGraphql: (handler: MockGraphqlHandler) => void;
    /** Queue responses for successive `bridge.graphql()` calls — for retry tests. */
    stubGraphqlSequence: (responses: MockApiResponse[]) => void;
    /** Every GraphQL call the app has made, in order. */
    graphqlCalls: () => MockGraphqlCall[];

    /**
     * Answer the next TOKEN_REFRESH. Auto-answered unless `autoToken(false)`.
     * `expiresAt` accepts ISO-8601 (what the real host sends) or a ms epoch.
     */
    sendToken: (token: string, expiresAt?: string | number) => void;
    /** Fail the next TOKEN_REFRESH. */
    failToken: (error: string) => void;
    /** Turn the automatic TOKEN_REFRESH answer on or off. Default on. */
    autoToken: (enabled: boolean) => void;

    /** Settle the open modal. */
    answerModal: (result: { confirmed: boolean; error?: string }) => void;
    /** Settle the open picker. */
    answerPicker: (result: { cancelled?: boolean; selections?: PickerSelection[]; error?: string }) => void;

    /** Post a completion from the most recent `connectExternal` popup. */
    completeExternal: (result: { connected: boolean; detail?: unknown }, origin?: string) => void;
    /** Close the most recent popup, as a merchant dismissing it would. */
    closePopup: () => void;

    /** Forget every recording. Stubs and the bridge survive. */
    reset: () => void;
    /** Restore the real `globalThis.window`. Call in `afterEach`. */
    restore: () => void;
}

const DEFAULT_ORIGIN = 'https://host.flashmandu.test';
const APP_ORIGIN = 'https://app.example.test';

const ALL_CAPABILITIES: HostCapabilities = {
    directApi: false,
    modal: true,
    picker: true,
    tokenRefresh: true,
    loading: true,
    theme: true,
};

interface FakeWindow extends EventTarget {
    parent: FakeWindow;
    postMessage: (message: unknown, targetOrigin: string) => void;
    location: { origin: string; search: string };
    open: (url: string, target: string, features: string) => Window | null;
}

/**
 * Build an in-memory host and install a fake `globalThis.window`.
 *
 * The fake window is the app's window AND its own parent, which is exactly the
 * relationship the bridge's origin/source gate checks — so the gate is
 * exercised for real rather than stubbed out.
 */
export function createMockHost(options: CreateMockHostOptions = {}): MockHost {
    const origin = options.origin ?? DEFAULT_ORIGIN;
    const appId = options.appId ?? 'app_test';
    const profileId = options.profileId ?? 1;
    const initialToken = options.token ?? 'tok_initial';
    const capabilities: HostCapabilities = { ...ALL_CAPABILITIES, ...options.capabilities };
    const autoContext = options.autoContext !== false;
    const defaultResponse: MockApiResponse = options.defaultResponse ?? { status: 200, body: {} };

    const search =
        `?session_token=${encodeURIComponent(initialToken)}` +
        `&app_id=${encodeURIComponent(appId)}` +
        `&profile_id=${profileId}` +
        `&parent_origin=${encodeURIComponent(origin)}`;

    const sent: RecordedMessage[] = [];
    const popups: MockPopup[] = [];
    let bridge: AppBridge | null = null;
    let hostNavSeq = 0;
    let autoTokenEnabled = true;
    let tokenCounter = 0;
    let pendingTokenId: number | null = null;
    let openModalId: number | null = null;
    let openPickerId: number | null = null;

    const attempts = new Map<string, number>();
    const fixed = new Map<string, MockApiResponse>();
    const sequences = new Map<string, MockApiResponse[]>();
    let handler: MockApiHandler | null = null;

    const graphqlLog: MockGraphqlCall[] = [];
    const graphqlQueue: MockApiResponse[] = [];
    let graphqlHandler: MockGraphqlHandler | null = null;

    const previousWindow = (globalThis as Record<string, unknown>).window;

    const fake = new EventTarget() as FakeWindow;
    fake.parent = fake;
    fake.location = { origin: APP_ORIGIN, search };
    fake.postMessage = (message: unknown, targetOrigin: string): void => {
        const envelope = message as { type?: unknown; payload?: unknown; channel?: unknown };
        if (typeof envelope?.type !== 'string') return;
        const record: RecordedMessage = {
            type: envelope.type,
            payload: envelope.payload,
            targetOrigin,
        };
        if (typeof envelope.channel === 'string') record.channel = envelope.channel;
        sent.push(record);
        react(envelope.type, envelope.payload);
    };
    fake.open = (url: string): Window | null => {
        const popup: MockPopup = {
            url,
            closed: false,
            close(): void {
                popup.closed = true;
            },
        };
        popups.push(popup);
        return popup as unknown as Window;
    };
    (globalThis as Record<string, unknown>).window = fake;

    /** Dispatch a host→iframe message through the same path a real host uses. */
    function post(type: string, payload?: unknown): void {
        const event = new Event('message') as Event & Record<string, unknown>;
        event.data = { type, payload };
        event.origin = origin;
        event.source = fake;
        fake.dispatchEvent(event);
    }

    function contextPayload(patch?: Record<string, unknown>): Record<string, unknown> {
        const base: Record<string, unknown> = {
            origin,
            profile: profileId,
            scopes: options.scopes ?? [],
            capabilities,
        };
        if (options.locale !== undefined) base.locale = options.locale;
        if (options.tz !== undefined) base.tz = options.tz;
        if (options.expiresAt !== undefined) base.expiresAt = options.expiresAt;
        if (options.channel !== undefined) base.channel = options.channel;
        if (options.theme !== undefined) base.theme = options.theme;
        return { ...base, ...patch };
    }

    function keyOf(method: string, path: string): string {
        return `${method} ${normalisePath(path)}`;
    }

    function resolveResponse(call: MockApiCall): MockApiResponse {
        const key = keyOf(call.method, call.path);
        const queue = sequences.get(key);
        if (queue !== undefined && queue.length > 0) {
            return queue.shift() as MockApiResponse;
        }
        const one = fixed.get(key);
        if (one !== undefined) return one;
        if (handler !== null) return handler(call);
        return defaultResponse;
    }

    function nextAttempt(method: string, path: string): number {
        const key = keyOf(method, path);
        const n = (attempts.get(key) ?? 0) + 1;
        attempts.set(key, n);
        return n;
    }

    /** The host's reflex reactions to app→host messages. */
    function react(type: string, payload: unknown): void {
        if (type === MessageType.Ready && autoContext) {
            post(MessageType.Context, contextPayload());
            return;
        }

        if (type === MessageType.Request) {
            const p = payload as ProxyRequestPayload;
            const call: MockApiCall = {
                method: p.method,
                path: p.path,
                body: p.body ?? null,
                transport: 'proxy',
                attempt: nextAttempt(p.method, p.path),
            };
            const response = resolveResponse(call);
            post(MessageType.Response, {
                id: p.id,
                status: response.status,
                body: response.body ?? null,
                retryAfter: response.retryAfter ?? null,
                remaining: response.remaining ?? null,
            });
            return;
        }

        if (type === MessageType.TokenRefresh) {
            const p = payload as { id?: number };
            pendingTokenId = typeof p?.id === 'number' ? p.id : null;
            if (autoTokenEnabled) {
                tokenCounter += 1;
                sendToken(`tok_refreshed_${tokenCounter}`);
            }
            return;
        }

        if (type === MessageType.ModalOpen) {
            openModalId = (payload as ModalOpenPayload)?.id ?? null;
            return;
        }

        if (type === MessageType.PickerOpen) {
            openPickerId = (payload as PickerOpenPayload)?.id ?? null;
        }
    }

    function sendToken(token: string, expiresAt?: string | number): void {
        const p: Record<string, unknown> = { token };
        if (pendingTokenId !== null) p.id = pendingTokenId;
        if (expiresAt !== undefined) p.expiresAt = expiresAt;
        pendingTokenId = null;
        post(MessageType.Token, p);
    }

    /**
     * The direct-API `fetch` stub.
     *
     * Speaks the same `{ method, path, body }` envelope the real direct
     * endpoint does, so a test can flip `capabilities.directApi` and assert the
     * app behaves identically on both transports — which is the whole promise
     * of §4.7.
     */
    /**
     * The direct GraphQL endpoint stub.
     *
     * Speaks the REAL contract: a `{ query, variables, operationName }` body,
     * a bearer token, and `X-RateLimit-*` / `Retry-After` response headers. It
     * deliberately does NOT understand the proxy's `{ method, path, body }`
     * envelope — if the SDK ever regressed to posting one here, these tests
     * would fail rather than pass against a fiction.
     */
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        const url = String(input);
        const raw = typeof init?.body === 'string' ? init.body : '{}';
        let parsed: {
            query?: string;
            variables?: Record<string, unknown>;
            operationName?: string;
        } = {};
        try {
            parsed = JSON.parse(raw);
        } catch {
            parsed = {};
        }
        const headers = (init?.headers ?? {}) as Record<string, string>;
        const auth = headers.Authorization ?? headers.authorization ?? '';

        if (typeof parsed.query !== 'string' || parsed.query === '') {
            // Exactly what the real endpoint does with a non-GraphQL body.
            return jsonResponse(400, { errors: [{ message: 'No GraphQL query supplied.' }] }, new Map());
        }

        const query = parsed.query;
        const priorAttempts = graphqlLog.filter((c) => c.query === query).length;
        const call: MockGraphqlCall = {
            query,
            variables: parsed.variables ?? null,
            operationName: parsed.operationName ?? null,
            token: auth.startsWith('Bearer ') ? auth.slice(7) : null,
            url,
            attempt: priorAttempts + 1,
        };
        graphqlLog.push(call);

        const response = graphqlQueue.length > 0
            ? (graphqlQueue.shift() as MockApiResponse)
            : (graphqlHandler?.(call) ?? { status: 200, body: { data: {} } });

        const headerMap = new Map<string, string>();
        if (response.retryAfter !== undefined && response.retryAfter !== null) {
            headerMap.set('retry-after', String(response.retryAfter));
        }
        if (response.remaining !== undefined && response.remaining !== null) {
            headerMap.set('x-ratelimit-remaining', String(response.remaining));
        }
        if (response.limit !== undefined && response.limit !== null) {
            headerMap.set('x-ratelimit-limit', String(response.limit));
        }
        if (response.reset !== undefined && response.reset !== null) {
            headerMap.set('x-ratelimit-reset', String(response.reset));
        }
        return jsonResponse(response.status, response.body ?? null, headerMap);
    }) as unknown as typeof fetch;

    function payloadsOf<T>(type: string): T[] {
        return sent.filter((m) => m.type === type).map((m) => m.payload as T);
    }

    const host: MockHost = {
        origin,
        search,
        sent,
        get bridge(): AppBridge | null {
            return bridge;
        },
        popups,
        fetchImpl,

        createBridge(overrides: Partial<CreateAppBridgeOptions> = {}): AppBridge {
            bridge = createAppBridge({
                search,
                parent: fake as unknown as Window,
                allowedParentOrigins: [origin],
                fetchImpl,
                openWindow: (url, target, features) => fake.open(url, target, features),
                ...overrides,
            });
            return bridge;
        },

        messagesOf<T = unknown>(type: string): T[] {
            return payloadsOf<T>(type);
        },
        pages: () => payloadsOf<SetPagePayload>(MessageType.SetPage),
        lastPage(): SetPagePayload | null {
            const all = payloadsOf<SetPagePayload>(MessageType.SetPage);
            return all.length === 0 ? null : (all[all.length - 1] as SetPagePayload);
        },
        toasts: () => payloadsOf<ToastPayload>(MessageType.Toast),
        loadingStates: () => payloadsOf<LoadingPayload>(MessageType.Loading).map((p) => p.active),
        navigations: () => payloadsOf<NavigatePayload>(MessageType.Navigate).map((p) => p.href),
        sidebarLinks(): SidebarLink[] | null {
            const all = payloadsOf<SetSidebarLinksPayload>(MessageType.SetSidebarLinks);
            return all.length === 0 ? null : (all[all.length - 1] as SetSidebarLinksPayload).links;
        },
        announcements: () =>
            payloadsOf<{ capabilities: BridgeCapabilities }>(MessageType.SetCapabilities).map(
                (p) => p.capabilities,
            ),
        acks: () => payloadsOf<HostNavigateAckPayload>(MessageType.HostNavigateAck),
        modalOpens: () => payloadsOf<ModalOpenPayload>(MessageType.ModalOpen),
        pickerOpens: () => payloadsOf<PickerOpenPayload>(MessageType.PickerOpen),
        tokenRefreshCount: () => sent.filter((m) => m.type === MessageType.TokenRefresh).length,

        post,
        setTheme(theme: ColorScheme): void {
            post(MessageType.Theme, { theme });
        },
        sendContext(patch): void {
            post(MessageType.Context, contextPayload(patch as Record<string, unknown> | undefined));
        },
        clickAction(id: string): void {
            post(MessageType.Action, { id });
        },
        hostNavigate(path: string): number {
            hostNavSeq += 1;
            post(MessageType.HostNavigate, { id: hostNavSeq, path });
            return hostNavSeq;
        },

        onApiCall(next: MockApiHandler): void {
            handler = next;
        },
        stub(method, path, response): void {
            fixed.set(keyOf(method, path), response);
        },
        stubSequence(method, path, responses): void {
            sequences.set(keyOf(method, path), [...responses]);
        },
        onGraphql(next: MockGraphqlHandler): void {
            graphqlHandler = next;
        },
        stubGraphqlSequence(responses: MockApiResponse[]): void {
            graphqlQueue.length = 0;
            graphqlQueue.push(...responses);
        },
        graphqlCalls: () => graphqlLog,

        sendToken,
        failToken(error: string): void {
            const p: Record<string, unknown> = { error, token: '' };
            if (pendingTokenId !== null) p.id = pendingTokenId;
            pendingTokenId = null;
            post(MessageType.Token, p);
        },
        autoToken(enabled: boolean): void {
            autoTokenEnabled = enabled;
        },

        answerModal(result): void {
            const p: Record<string, unknown> = { confirmed: result.confirmed };
            if (openModalId !== null) p.id = openModalId;
            if (result.error !== undefined) p.error = result.error;
            openModalId = null;
            post(MessageType.ModalResult, p);
        },
        answerPicker(result): void {
            const selections = result.selections ?? [];
            const p: Record<string, unknown> = {
                cancelled: result.cancelled ?? selections.length === 0,
                selections,
            };
            if (openPickerId !== null) p.id = openPickerId;
            if (result.error !== undefined) p.error = result.error;
            openPickerId = null;
            post(MessageType.PickerResult, p);
        },

        completeExternal(result, from?: string): void {
            const popup = popups[popups.length - 1];
            if (popup === undefined) return;
            const event = new Event('message') as Event & Record<string, unknown>;
            event.data = { connected: result.connected, detail: result.detail };
            event.origin = from ?? APP_ORIGIN;
            event.source = popup;
            fake.dispatchEvent(event);
        },
        closePopup(): void {
            const popup = popups[popups.length - 1];
            if (popup !== undefined) popup.closed = true;
        },

        reset(): void {
            sent.length = 0;
            popups.length = 0;
            attempts.clear();
            graphqlLog.length = 0;
        },
        restore(): void {
            if (previousWindow === undefined) {
                delete (globalThis as Record<string, unknown>).window;
            } else {
                (globalThis as Record<string, unknown>).window = previousWindow;
            }
        },
    };

    return host;
}

function jsonResponse(status: number, body: unknown, headers: Map<string, string>): Response {
    return {
        status,
        ok: status >= 200 && status < 300,
        headers: { get: (name: string) => headers.get(name.toLowerCase()) ?? null },
        json: async () => body,
    } as unknown as Response;
}

function normalisePath(path: string): string {
    return path.startsWith('/') ? path.slice(1) : path;
}
