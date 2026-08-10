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

/** Core budget, gzipped bytes. */
const BUDGET_BYTES = 6 * 1024;

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
