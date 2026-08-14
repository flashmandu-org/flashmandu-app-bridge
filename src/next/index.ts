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
 *
 * This entry is built with a `"use client"` banner (see tsup.config.ts), so it
 * only exports the genuine Client Component, `UrlSync`. The OAuth/webhook/
 * revalidate route factories are server-only and live at the sibling,
 * non-banner subpath `@flashmandu/app-bridge/next/routes` — import them from
 * there, not from here.
 */

export { UrlSync } from './url-sync.js';
