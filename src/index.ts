/**
 * @flashmandu/app-bridge — in-iframe App Bridge SDK (protocol v2).
 *
 * The npm package an embedded Flashmandu app installs to drive itself from
 * inside the platform's iframe. The app's api_token never reaches the browser
 * — and the direct GraphQL endpoint rejects it outright whenever an `Origin`
 * header is present, so only short-TTL session tokens work from a browser.
 *
 * Two API surfaces, deliberately not interchangeable: `request()` speaks REST
 * over the host's postMessage proxy and is always available, while `graphql()`
 * posts a real GraphQL document straight to the platform (removing two
 * serialisations and the host's main-thread hop) and requires the host to have
 * announced `capabilities.directApi`.
 *
 * Quickstart:
 *
 * ```ts
 * import { createAppBridge } from '@flashmandu/app-bridge';
 *
 * const bridge = createAppBridge();
 * const ctx = await bridge.ready();
 *
 * bridge.setPage({
 *   title: 'Maps',
 *   crumbs: [{ label: 'Maps', path: '/maps' }, { label: 'Kathmandu' }],
 *   actions: [{ id: 'save', label: 'Save', variant: 'primary' }],
 *   dirty: false,
 * });
 * bridge.onAction((id) => { if (id === 'save') save(); });
 *
 * const me = await bridge.request({ method: 'GET', path: 'me' });
 * ```
 *
 * Optional entry points, kept out of the core bundle so they tree-shake away:
 * `@flashmandu/app-bridge/modal` (host modal + resource picker),
 * `@flashmandu/app-bridge/testing` (in-memory mock host),
 * `@flashmandu/app-bridge/react`, `@flashmandu/app-bridge/next`.
 */

export {
    createAppBridge,
    DEFAULT_DIRECT_API_ENDPOINT,
    TOKEN_FRESHNESS_MARGIN_MS,
} from './app-bridge.js';
export type {
    AppBridge,
    ConnectExternalOptions,
    ConnectExternalResult,
    CreateAppBridgeOptions,
    GraphqlOptions,
    ModalApi,
    PickerApi,
    ToastOptions,
} from './app-bridge.js';
export type {
    ActionPayload,
    AppContext,
    BridgeCapabilities,
    BridgeChannel,
    BridgeEventName,
    BridgeListener,
    BridgeMessage,
    ContextPayload,
    HostCapabilities,
    HostNavigateAckPayload,
    HostNavigatePayload,
    LoadingPayload,
    MessageTypeValue,
    ModalClosePayload,
    ModalMode,
    ModalOpenPayload,
    ModalResultPayload,
    NavigatePayload,
    PageAction,
    PageActionVariant,
    PageCrumb,
    PickerKind,
    PickerOpenPayload,
    PickerResultPayload,
    PickerSelection,
    ProxyMethod,
    ProxyRequestPayload,
    ProxyResponsePayload,
    ReadyPayload,
    RequestOptions,
    ResponseResult,
    SetCapabilitiesPayload,
    SetPagePayload,
    SetSidebarLinksPayload,
    SidebarLink,
    ToastAction,
    ToastPayload,
    ToastVariant,
    TokenPayload,
    TokenRefreshPayload,
} from './types.js';
export { MessageType } from './types.js';
export {
    createTransport,
    readQueryParam,
    resolveParentOrigin,
} from './transport.js';
export type { Transport, TransportHandlers } from './transport.js';

/**
 * Page-chrome rules. Exported so a host, a PHP runtime, or a component kit can
 * apply the identical caps rather than re-deriving them.
 */
export {
    BridgeValidationError,
    isAppRelativePath,
    normalisePageChrome,
    pageChromeEquals,
    PAGE_CHROME_LIMITS,
} from './page-chrome.js';

/** Retry policy. Pure functions, exported for host parity and for testing. */
export {
    backoffDelayMs,
    DEFAULT_RETRY_POLICY,
    parseRemaining,
    parseRetryAfter,
    RETRYABLE_STATUSES,
    shouldRetry,
} from './retry.js';
export type { RetryPolicy } from './retry.js';

/**
 * URL state — the single, framework-free place that decides which parts of an
 * embedded app's URL belong in the host's address bar. Exported so the host
 * shell and non-JS runtimes apply the identical rule.
 */
export {
    BRIDGE_RESERVED_PARAMS,
    EPHEMERAL_PARAM_PREFIX,
    isGlobalParam,
    globalParamsOf,
    normaliseAppPath,
    buildPathChangePayload,
    buildAppUrl,
} from './url-state.js';
export type { PathChangePayload } from './url-state.js';
