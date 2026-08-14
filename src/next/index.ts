/**
 * @flashmandu/app-bridge/next — Next.js App Router adapters.
 *
 * The components in `@flashmandu/app-bridge/react` are deliberately
 * router-agnostic: they take `pathname` and navigation callbacks as props so
 * they work under any framework (or none). That keeps the core usable from
 * Vue, Svelte, or a plain-DOM app.
 *
 * This subpath supplies the Next.js wiring so App Router apps do not each
 * re-implement the same `usePathname()` / `useRouter()` glue. Import from here
 * in a Next app; import from `/react` if you are wiring another router.
 *
 * `next` is an OPTIONAL peer dependency — nothing in the package root or in
 * `/react` imports it, so non-Next consumers never pull Next into their graph.
 */

export { UrlSync } from './url-sync.js';

export { createOAuthRoutes, createRevalidateHandler, createWebhookRoute } from './routes.js';
export type { CreateWebhookRouteOptions, OAuthRoutes, WebhookRoute } from './routes.js';
