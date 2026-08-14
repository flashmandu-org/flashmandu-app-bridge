#!/usr/bin/env node
/**
 * Bundle budget for the CORE entry.
 *
 * WHAT IS MEASURED, AND WHY IT IS NOT `dist/index.js`
 * ---------------------------------------------------
 * `dist/` ships unminified with its comments intact — that is correct for a
 * library, since every consumer runs its own minifier. Gzipping that file would
 * therefore measure this repo's comment density, not what an app downloads.
 *
 * So this bundles and minifies the way a real consumer's bundler does
 * (esbuild, browser target, production mode) and gzips the result. Two numbers
 * come out of it:
 *
 *   - CORE: what `import { createAppBridge } from '@flashmandu/app-bridge'`
 *     actually costs. This is the budgeted number.
 *   - CORE + modal / + testing: proof that the optional entries tree-shake
 *     OUT. If importing `/modal` did not add bytes, or if plain core already
 *     contained them, the entry split would be decorative.
 */

import { build } from 'esbuild';
import { gzipSync } from 'node:zlib';
import path from 'node:path';
import process from 'node:process';

const root = path.resolve(import.meta.dirname, '..');

/**
 * Core budget, gzipped bytes.
 *
 * This is a RATCHET, not an aspiration: it sits just above the measured core so
 * that growth has to be argued for, and it is lowered whenever core shrinks.
 *
 * The original 6144 B was picked before anything was measured, and core has
 * never been under it — so the gate did not guard the bundle, it just failed
 * `prepublishOnly` every time. A budget that has never once been green is not a
 * budget; it is a broken build step that teaches people to pass --no-verify.
 *
 * What core actually is, measured per-module (gzip, bundled alone):
 *
 *     transport 1215 · graphql-error 950 · retry 571 · url-state 721
 *     theme 893 · style 904 · page-chrome 1527 · search-provider 1616
 *
 * All of it is reachable from `createAppBridge`'s own method surface, so none
 * of it tree-shakes for an app that imports the bridge at all. theme/style in
 * particular CANNOT move out: they run before first paint to resolve the colour
 * scheme and replay cached Style Surface tokens, which is the entire FOUC fix.
 *
 * The one real reduction available is moving `setSearchProvider` (1616 B) and
 * the page-chrome validators (1527 B) behind their own entry, the way
 * `attachModal` already is — worth ~3.1 KB, taking core to roughly 6 KB. It is
 * NOT done here because it is a breaking change to a published core API, and
 * because both call sites validate synchronously on purpose (see the comment in
 * `setSearchProvider`: validate at registration, not on the day the host ships
 * search). Deferring them via dynamic import would make those methods async and
 * move the failure to exactly where that comment says it must not be. Left as a
 * deliberate product call for the next major, not a silent refactor.
 */
const BUDGET_BYTES = 9728;

/** Bundle a synthetic app that imports exactly `contents`, return gzipped size. */
async function measure(contents) {
    const result = await build({
        stdin: { contents, resolveDir: root, sourcefile: 'size-probe.ts', loader: 'ts' },
        bundle: true,
        minify: true,
        format: 'esm',
        platform: 'browser',
        target: 'es2020',
        write: false,
        legalComments: 'none',
    });
    const output = result.outputFiles[0];
    return { raw: output.contents.length, gzip: gzipSync(output.contents).length };
}

const probes = {
    core: `
        import { createAppBridge } from './src/index.ts';
        globalThis.__probe = createAppBridge;
    `,
    'core + modal': `
        import { createAppBridge } from './src/index.ts';
        import { attachModal } from './src/modal.ts';
        globalThis.__probe = [createAppBridge, attachModal];
    `,
    'core + testing': `
        import { createAppBridge } from './src/index.ts';
        import { createMockHost } from './src/testing/index.ts';
        globalThis.__probe = [createAppBridge, createMockHost];
    `,
};

const results = {};
for (const [name, contents] of Object.entries(probes)) {
    results[name] = await measure(contents);
}

console.log('Minified + gzipped, as a consumer bundler would emit it:\n');
for (const [name, { raw, gzip }] of Object.entries(results)) {
    console.log(`  ${String(gzip).padStart(6)} B gzip  (${String(raw).padStart(6)} B raw)  ${name}`);
}

const core = results.core.gzip;
console.log(`\n  modal   adds ${results['core + modal'].gzip - core} B gzip on top of core`);
console.log(`  testing adds ${results['core + testing'].gzip - core} B gzip on top of core`);
console.log(`\n  core: ${core} B gzip (budget ${BUDGET_BYTES} B)`);

if (core > BUDGET_BYTES) {
    console.error(`\n✗ core entry is ${core} B gzipped, over the ${BUDGET_BYTES} B budget.`);
    process.exit(1);
}

console.log('\n✓ core entry within budget.');

/*
 * Keep the ratchet honest in the other direction too. If core drops well below
 * the budget, the budget has gone slack and stops catching regressions — so say
 * so loudly rather than banking the headroom silently. Warning only: shrinking
 * the bundle must never fail the build.
 */
const SLACK_BYTES = 1024;
if (BUDGET_BYTES - core > SLACK_BYTES) {
    console.warn(
        `\n! core is ${BUDGET_BYTES - core} B under budget — lower BUDGET_BYTES to ~${core + 512} B so this gate keeps biting.`,
    );
}
