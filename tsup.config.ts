import { defineConfig } from 'tsup';

/**
 * Two build passes, because the entries have different client/server semantics.
 *
 * The `'use client'` directive is per-MODULE, and tsup/esbuild drops per-file
 * directives when it bundles several modules into one output file. Without it
 * the React entry is treated as a Server Component by Next's App Router and
 * every consumer explodes with:
 *
 *   You're importing a component that needs useEffect. It only works in a
 *   Client Component but none of its parents are marked with "use client".
 *
 * Apps used to paper over this with one-line re-export shims that re-added the
 * directive locally (app/_components/BridgeContext.tsx and friends). Banner-ing
 * it onto the bundle fixes the cause, so those shims can be deleted.
 *
 * The core entry deliberately does NOT get the banner: it is framework-free and
 * must stay usable from a Server Component, a Node script, or no framework at
 * all. `verify-framework-free.mjs` enforces the other half of that contract.
 *
 * That non-banner constraint is why `src/next/routes.ts` (the OAuth/webhook/
 * revalidate route factories) is built in the FIRST pass even though it lives
 * under `src/next/`. Those factories are server-only Fetch `Request` ->
 * `Response` handlers with no React/Next import — the banner pass would wrap
 * them in `"use client"` and merge them into the same chunk as `UrlSync`,
 * mislabeling server code as a Client Component and pulling `node:crypto`/
 * `node:fs` into any bundle that touches it. They ship from the DIST subpath
 * `next/routes.{js,cjs,d.ts}` (source and package `exports` subpath
 * `./next/routes` — see package.json) so consumers get server code from a
 * module that was never client-tainted. `src/next/index.ts` keeps only the
 * genuine client export (`UrlSync`) and stays in the banner pass below.
 */
export default defineConfig([
    {
        // Core + the optional framework-free entries. They live in the same
        // pass so tsup emits ONE shared chunk for the code they have in
        // common (types, page-chrome) instead of duplicating it into several
        // bundles. An app that never imports `/modal`, `/testing`, `/server`,
        // or `/next/routes` never loads them. `/server` and `/next/routes`
        // are Node-only (use node:fs/node:crypto) but stay framework-free —
        // no React/Next import, so no banner and no client taint.
        entry: [
            'src/index.ts',
            'src/modal.ts',
            'src/testing/index.ts',
            'src/server/index.ts',
            'src/next/routes.ts',
        ],
        format: ['esm', 'cjs'],
        dts: true,
        // NOT `clean: true`. tsup runs the two passes concurrently, so a
        // `clean` here races the other pass and intermittently deletes the
        // freshly-written `dist/react/*.d.ts` / `dist/next/*.d.ts` — which
        // `verify:exports` then (correctly) fails the release on. `npm run
        // clean` is the single writer of that deletion; `prepublishOnly`
        // already chains it ahead of the build.
        clean: false,
    },
    {
        // Client-only entries. These genuinely need `"use client"` — React
        // hooks (`/react`) and the Next `UrlSync` wrapper (`/next`) — so they
        // get the banner. Nothing server-only belongs in this pass.
        entry: ['src/react/index.ts', 'src/next/index.ts'],
        format: ['esm', 'cjs'],
        dts: true,
        clean: false,
        banner: { js: '"use client";' },
    },
]);
