'use client';

/**
 * Next.js-wired UrlSync.
 *
 * Reads the current pathname from `next/navigation`, routes host deep-links
 * back through the Next router, and mirrors in-app navigation into the
 * platform's address bar (the host answers PATH_CHANGE by rewriting `?path=`).
 * An app only has to render `<UrlSync />`.
 *
 * ── WHERE THE TARGET ORIGIN COMES FROM ───────────────────────────────────
 * PATH_CHANGE was originally posted with targetOrigin '*', broadcasting the
 * merchant's navigation to any frame listening on the page. Narrowing that is
 * correct — but the origin has to come from somewhere reliable:
 *
 *  - Re-deriving it from `?parent_origin` / document.referrer is NOT reliable:
 *    inside the embed iframe the param is frequently absent and the referrer
 *    can be stripped by policy. Failing closed then silently kills path sync.
 *  - `bridge.context` is the authenticated value (the transport only accepts
 *    CONTEXT from the origin it validated) — but it is NULL until ready()
 *    settles, and useAppBridge() can report "ready" earlier than that from a
 *    cached profile id. Reading it synchronously yields undefined.
 *
 * So: subscribe to the handshake and take the origin from the resolved
 * context, falling back to the transport's own resolution only if the bridge
 * never settles. Until an origin is known we post nothing (fail closed) but
 * keep rendering, so the first sync fires the moment it arrives.
 */

import { Suspense, useEffect, useRef, useState } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { getBridge, subscribeHostNavigation } from '../react/use-app-bridge.js';
import { resolveParentOrigin } from '../transport.js';
import { UrlSync as UrlSyncBase } from '../react/url-sync.js';

export interface UrlSyncProps {
  /** Optional allowlist, mirroring createAppBridge. */
  allowedParentOrigins?: readonly string[];
}

/**
 * Suspense boundary owned by the package.
 *
 * `useSearchParams()` opts a route into client-side rendering, and Next fails
 * the build ("should be wrapped in a suspense boundary") unless the caller
 * provides one. Requiring every app to wrap `<UrlSync />` themselves would be
 * exactly the kind of per-app wiring this package exists to remove — and the
 * failure only shows up at `next build`, not in dev. So we own the boundary.
 * The fallback is null: UrlSync renders nothing anyway.
 */
export function UrlSync(props: UrlSyncProps = {}): React.ReactElement {
  return (
    <Suspense fallback={null}>
      <UrlSyncInner {...props} />
    </Suspense>
  );
}

function UrlSyncInner({
  allowedParentOrigins,
}: UrlSyncProps = {}): React.ReactElement | null {
  const pathname = usePathname() ?? '/';
  const router = useRouter();
  // Query params are picked up automatically — an app never declares which of
  // its params are shareable. See ../url-state.ts for the rule.
  const searchParams = useSearchParams();
  const search = searchParams?.toString() ? `?${searchParams.toString()}` : '';
  const [origin, setOrigin] = useState<string | null>(null);

  // Read at delivery time by the host-navigation subscription below, which is
  // mount-only and must not close over a stale router or pathname.
  const latest = useRef({ router, pathname, search });
  latest.current = { router, pathname, search };

  // ── INBOUND: the merchant clicked one of this app's sidebar links ─────────
  //
  // Mount-only, and deliberately NOT keyed on [router] as one might expect.
  // Re-subscribing tears the last listener down and adds a new one, and the
  // bridge announces capability on those transitions — so a dependency that
  // changes identity per render would flap `hostNavigate` false/true at the
  // host on every navigation. One stable subscription for the component's
  // lifetime; the ref above keeps it current.
  useEffect(() => {
    if (typeof window === 'undefined' || window.self === window.top) return;

    return subscribeHostNavigation(getBridge(), {
      push: (path) => latest.current.router.push(path),
      currentUrl: () => `${latest.current.pathname}${latest.current.search}`,
    });
  }, []);

  useEffect(() => {
    if (typeof window === 'undefined' || window.self === window.top) return;

    let cancelled = false;

    // Primary: the origin the bridge authenticated during the handshake.
    const bridge = getBridge();
    const fromContext = bridge.context?.origin;
    if (typeof fromContext === 'string' && fromContext !== '') {
      setOrigin(fromContext);
    } else {
      bridge
        .ready()
        .then((ctx) => {
          if (!cancelled && typeof ctx?.origin === 'string' && ctx.origin !== '') {
            setOrigin(ctx.origin);
          }
        })
        .catch(() => {
          // Fallback: the transport's own resolution. Still never '*'.
          if (cancelled) return;
          const resolved = resolveParentOrigin(window.location.search, allowedParentOrigins);
          if (resolved !== null) setOrigin(resolved);
        });
    }

    return () => {
      cancelled = true;
    };
  }, [allowedParentOrigins]);

  return (
    <UrlSyncBase
      pathname={pathname}
      search={search}
      {...(origin !== null ? { targetOrigin: origin } : {})}
      {...(allowedParentOrigins !== undefined ? { allowedParentOrigins } : {})}
      onDeepLink={(path) => router.replace(path)}
    />
  );
}
