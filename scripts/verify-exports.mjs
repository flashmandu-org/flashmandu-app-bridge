#!/usr/bin/env node
/**
 * Publish gate: prove every declared export is actually SHIPPED.
 *
 * Why this exists
 * ---------------
 * @flashmandu/app-bridge 0.1.0 shipped to npm declaring only `"."` while the
 * repo had already added `./react`. Local apps used `file:` deps and resolved
 * the working tree, so nothing failed until a real app installed from the
 * registry and hit:
 *
 *   Module not found: Package path ./react is not exported from package
 *
 * A version policy cannot catch that class of bug. The only thing that can is
 * packing the tarball and resolving each declared export against its CONTENTS
 * — which is what this does.
 *
 * It runs `npm pack`, extracts the tarball to a temp dir, walks every path in
 * `exports`, and asserts each mapped target exists inside the package. Exits
 * non-zero on the first missing target.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';

const root = path.resolve(import.meta.dirname, '..');
const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));

/**
 * Collect every file path referenced by an `exports` value. Handles the string
 * form, conditional objects ({ import, require, types, default }), and arrays,
 * recursing through nested conditions.
 */
function targetsOf(value, out = []) {
    if (typeof value === 'string') {
        out.push(value);
    } else if (Array.isArray(value)) {
        for (const entry of value) targetsOf(entry, out);
    } else if (value && typeof value === 'object') {
        for (const entry of Object.values(value)) targetsOf(entry, out);
    }
    return out;
}

const staging = mkdtempSync(path.join(tmpdir(), 'fm-verify-exports-'));

try {
    // Pack from the repo root; --pack-destination keeps the tarball out of the tree.
    const packOutput = execFileSync(
        'npm',
        ['pack', '--silent', '--pack-destination', staging],
        { cwd: root, encoding: 'utf8' },
    );

    const tarball = path.join(staging, packOutput.trim().split('\n').pop().trim());
    if (!existsSync(tarball)) {
        throw new Error(`npm pack did not produce a tarball at ${tarball}`);
    }

    // npm tarballs always root everything under `package/`.
    execFileSync('tar', ['-xzf', tarball, '-C', staging], { stdio: 'inherit' });
    const packageDir = path.join(staging, 'package');

    const exportsField = pkg.exports ?? { '.': pkg.main };
    const failures = [];
    let checked = 0;

    for (const [subpath, value] of Object.entries(exportsField)) {
        for (const target of targetsOf(value)) {
            if (typeof target !== 'string' || !target.startsWith('.')) continue;
            checked += 1;
            const resolved = path.join(packageDir, target);
            if (!existsSync(resolved)) {
                failures.push(`  ${subpath} → ${target}  (NOT in tarball)`);
            }
        }
    }

    // Guard the root entry points too — `main`/`module`/`types` are still
    // consulted by older bundlers that ignore `exports`.
    for (const key of ['main', 'module', 'types', 'browser']) {
        const target = pkg[key];
        if (typeof target !== 'string' || !target.startsWith('.')) continue;
        checked += 1;
        if (!existsSync(path.join(packageDir, target))) {
            failures.push(`  ${key} → ${target}  (NOT in tarball)`);
        }
    }

    if (failures.length > 0) {
        console.error(
            `\n✗ ${pkg.name}@${pkg.version} declares ${failures.length} export target(s) it does not ship:\n`,
        );
        console.error(failures.join('\n'));
        console.error(
            '\nFix the `files` array or the build script so these land in the tarball, then re-run.\n',
        );
        process.exit(1);
    }

    console.log(`✓ ${pkg.name}@${pkg.version} — all ${checked} declared export targets present in tarball.`);
} finally {
    rmSync(staging, { recursive: true, force: true });
}
