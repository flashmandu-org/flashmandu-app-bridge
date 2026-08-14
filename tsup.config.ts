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
 */
export default defineConfig([
    {
        // Core + the three optional framework-free entries. They live in the
        // same pass so tsup emits ONE shared chunk for the code they have in
        // common (types, page-chrome) instead of duplicating it into several
        // bundles. An app that never imports `/modal`, `/testing`, or
        // `/server` never loads them. `/server` is Node-only (uses
        // node:fs/node:crypto) but stays framework-free — no React/Next.
        entry: ['src/index.ts', 'src/modal.ts', 'src/testing/index.ts', 'src/server/index.ts'],
        format: ['esm', 'cjs'],
        dts: true,
        clean: true,
    },
    {
        entry: ['src/react/index.ts', 'src/next/index.ts'],
        format: ['esm', 'cjs'],
        dts: true,
        clean: false,
        banner: { js: '"use client";' },
    },
]);
