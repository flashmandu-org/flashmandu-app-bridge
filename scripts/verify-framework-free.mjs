#!/usr/bin/env node
/**
 * Architectural invariant: the CORE entry must not depend on any UI framework.
 *
 * Why this matters
 * ----------------
 * The App Bridge is meant to serve Next.js, PHP, Python and whatever comes
 * next. That promise only holds if `@flashmandu/app-bridge` (the root entry)
 * stays framework-free — the protocol and transport are the portable surface,
 * and React/Next live behind the `/react` and `/next` subpaths.
 *
 * It is very easy to break this by accident: one stray `import { useState }`
 * in a core file and every PHP or Python consumer suddenly needs React in
 * their bundle graph. Bundlers will not complain — they will just quietly
 * include it.
 *
 * This script follows the root entry's chunk graph and fails if it can reach a
 * framework import. Run after build, before publish.
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const dist = path.resolve(import.meta.dirname, '..', 'dist');

/** Bare specifiers that must never appear in the core graph. */
const FORBIDDEN = [/^react$/, /^react\//, /^react-dom/, /^next$/, /^next\//, /^vue$/, /^svelte/];

/** Extract every bare (non-relative) import specifier from a built file. */
function importsOf(file) {
    const source = readFileSync(file, 'utf8');
    const specifiers = new Set();
    const patterns = [
        /(?:from|import)\s*["']([^"']+)["']/g,
        /require\(\s*["']([^"']+)["']\s*\)/g,
    ];

    for (const pattern of patterns) {
        let match;
        while ((match = pattern.exec(source)) !== null) {
            specifiers.add(match[1]);
        }
    }
    return [...specifiers];
}

/** Walk the entry's relative-import graph, collecting bare specifiers. */
function reachableBareImports(entry) {
    const seen = new Set();
    const queue = [entry];
    const bare = new Map(); // specifier -> file that imported it

    while (queue.length > 0) {
        const file = queue.pop();
        if (seen.has(file) || !existsSync(file)) continue;
        seen.add(file);

        for (const spec of importsOf(file)) {
            if (spec.startsWith('.')) {
                const resolved = path.resolve(path.dirname(file), spec);
                queue.push(resolved);
                continue;
            }
            if (!bare.has(spec)) bare.set(spec, path.relative(dist, file));
        }
    }

    return bare;
}

if (!existsSync(dist)) {
    console.error('✗ dist/ not found — run `npm run build` first.');
    process.exit(1);
}

// Check every root-level entry file (index.js / index.cjs), not the subpaths.
const entries = readdirSync(dist)
    .filter((f) => /^index\.(js|cjs)$/.test(f))
    .map((f) => path.join(dist, f));

if (entries.length === 0) {
    console.error('✗ no root entry (dist/index.js) found — did the build change?');
    process.exit(1);
}

const violations = [];

for (const entry of entries) {
    for (const [spec, importer] of reachableBareImports(entry)) {
        if (FORBIDDEN.some((re) => re.test(spec))) {
            violations.push(`  ${path.basename(entry)} reaches "${spec}"  (via ${importer})`);
        }
    }
}

if (violations.length > 0) {
    console.error('\n✗ The core entry is no longer framework-free:\n');
    console.error(violations.join('\n'));
    console.error(
        '\nMove the offending code into src/react/ or src/next/. The root entry must stay\n' +
        'usable from non-JS runtimes (PHP, Python) that only speak the bridge protocol.\n',
    );
    process.exit(1);
}

console.log(`✓ core entry is framework-free (checked ${entries.length} root entry point(s)).`);
