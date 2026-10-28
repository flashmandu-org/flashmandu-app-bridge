/**
 * `revalidateProfile` — platform cache revalidation, callable in-process.
 *
 * The platform caches embed-block data derived from this app's rows — the
 * block picker markup in the page builder and the dynamic-options payloads
 * behind block dropdowns. After any mutation to the data your blocks render,
 * tell the platform to drop those caches or the builder keeps showing stale
 * choices for the cache TTL.
 *
 * SDK GAP this closes: `@flashmandu/app-bridge/next/routes`' original
 * `createRevalidateHandler` only shipped as a Next.js
 * `(req: Request) => Promise<Response>` route factory — meant to be mounted
 * at a route the platform POSTs to — with no plain callable usable from a
 * server action with just a `profileId` in hand. Two independent app
 * migrations (tours, orbit) hit this and both wrote the identical
 * workaround: wrapping the route factory in a synthetic internal `Request`
 * just to call it in-process from `lib/actions/*`. That is exactly the
 * copy-paste duplication this SDK exists to eliminate, so the fetch +
 * error-swallowing logic now lives here once, and `createRevalidateHandler`
 * (`../next/routes.js`) is a thin HTTP wrapper around this function.
 *
 * Fire-and-forget by design: a failed purge must never fail the merchant's
 * own save — the platform TTLs are the safety net. This function never
 * throws and never returns a value a caller could branch on; `await` it only
 * to know the purge attempt has settled, not that it succeeded.
 */

import type { AppConfig } from './config.js';

export async function revalidateProfile(cfg: AppConfig, profileId?: number): Promise<void> {
    try {
        const apiToken = cfg.apiToken;
        // 0.6.6: `apiBase` (FLASHMANDU_API_BASE on a pod, the dev-box URL in
        // local dev). Before it, a pod had no dev-box URL and this never fired.
        const apiBase = cfg.apiBase;

        if (apiBase === '') return;

        await fetch(`${apiBase}/api/apps/embed/revalidate`, {
            method: 'POST',
            headers: {
                Authorization: `Bearer ${apiToken}`,
                'Content-Type': 'application/json',
            },
            // One platform-hosted pod serves every installing profile with a
            // shared credential, so name the profile that was just mutated —
            // the platform purges that profile's caches (verified against
            // its install rows).
            body: JSON.stringify(profileId ? { profile_id: profileId } : {}),
            cache: 'no-store',
            signal: AbortSignal.timeout(5000),
        });
    } catch {
        // Intentionally swallowed — see docblock.
    }
}
