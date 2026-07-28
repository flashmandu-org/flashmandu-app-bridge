/**
 * @flashmandu/app-bridge — in-iframe App Bridge SDK.
 *
 * The npm package an embedded Flashmandu app installs to drive itself from
 * inside the platform's iframe. postMessage is the only transport; the app's
 * api_token never reaches the browser — every API call is proxied through the
 * host's same-origin `/api/apps/proxy` route under the merchant's session.
 *
 * Quickstart:
 *
 * ```ts
 * import { createAppBridge } from '@flashmandu/app-bridge';
 *
 * const bridge = createAppBridge();
 * const ctx = await bridge.ready();
 * console.log('Embedded in', ctx.origin);
 *
 * const me = await bridge.request({ method: 'GET', path: 'me' });
 * ```
 */

export { createAppBridge } from './app-bridge.js';
export type {
    AppBridge,
    CreateAppBridgeOptions,
} from './app-bridge.js';
export type {
    AppContext,
    BridgeEventName,
    BridgeListener,
    BridgeMessage,
    ContextPayload,
    MessageTypeValue,
    NavigatePayload,
    ProxyMethod,
    ProxyRequestPayload,
    ProxyResponsePayload,
    ReadyPayload,
    RequestOptions,
    ResponseResult,
    SetTitlePayload,
    ToastPayload,
    ToastVariant,
} from './types.js';
export { MessageType } from './types.js';
export {
    createTransport,
    readQueryParam,
    resolveParentOrigin,
} from './transport.js';
export type { Transport, TransportHandlers } from './transport.js';
