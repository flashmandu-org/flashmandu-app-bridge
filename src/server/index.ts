/**
 * @flashmandu/app-bridge/server — runtime-agnostic Node server helpers.
 *
 * Framework-free (no Next.js import) so it is usable from any Node runtime —
 * a plain Node script, a different framework, or a test file. Next.js route
 * factories that build on these live in `@flashmandu/app-bridge/next/routes`.
 */
export { loadConfig } from './config.js';
export type { AppConfig } from './config.js';

export { createFlashmanduClient } from './flashmandu.js';
export type { FlashmanduClient, FlashmanduClientOptions } from './flashmandu.js';

export { revalidateProfile } from './revalidate.js';

export {
    DEFAULT_MAX_SKEW_SECONDS,
    readWebhookHeaders,
    signWebhook,
    verifyWebhook,
} from './webhooks.js';
export type { VerifyResult, VerifyWebhookInput, WebhookHeaders } from './webhooks.js';

export {
    mintEmbedToken,
    resolveProfile,
    verifyEmbedToken,
    verifyEmbedTokenDetailed,
} from './auth.js';
export type { VerifyTokenBad, VerifyTokenOk, VerifyTokenResult } from './auth.js';
