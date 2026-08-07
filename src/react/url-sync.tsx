/**
 * @flashmandu/app-bridge/react — UrlSync component.
 *
 * Keeps the platform's address bar in sync with the app's current page AND its
 * shareable view state, and deep-links back into the app on load.
 *
 * Router-agnostic: takes `pathname` + `search` as props so it works under any
 * framework. The Next-wired variant lives at `@flashmandu/app-bridge/next`.
 *
 * WHAT GETS SYNCED is not decided here and is not decided per app — see
 * ../url-state.ts. Path plus every non-reserved, non-`_`-prefixed query param.
 * Noop when standalone.
 */
'use client';

import { useEffect, useRef } from 'react';
import { resolveParentOrigin } from '../transport.js';
import { buildAppUrl, buildPathChangePayload } from '../url-state.js';
import { getBridge, subscribeHostNavigation } from './use-app-bridge.js';

export interface UrlSyncProps {
  /** Current route pathname (e.g. "/maps", "/maps/new"). */
  pathname: string;
  /**
   * Current route search string (e.g. "?q=kath&status=draft"). Optional for
   * back-compat; omit and only the path is mirrored.
   */
  search?: string;
  /** Handle deep-link navigation on mount. Receives path + query. */
  onDeepLink?: (path: string) => void;
  /**
   * Route the app when the merchant clicks one of its host sidebar links.
   *
   * Deliberately separate from `onDeepLink`: a deep-link restore corrects the
   * current history entry (`router.replace`), while a host navigation is a new
   * entry the merchant can go back from (`router.push`). Overloading one
   * callback would force one of the two to be wrong.
   *
   * **Pass it and the component subscribes; omit it and it does not.** That is
   * load-bearing: subscribing announces `hostNavigate: true` to the host, which
   * is what makes the host suppress the click — announcing it with nothing to
   * handle the navigation would hang the merchant on a dead link, which is
   * strictly worse than the full-page navigation you get by omitting it.
   *
   * Read at MOUNT to decide whether to subscribe, so pass it unconditionally or
   * not at all; the function itself may be a fresh inline arrow every render.
   */
  onNavigate?: (path: string) => void;
  /**
   * Explicit parent origin to post to. Defaults to the same resolution the
   * transport uses. Never widen this to '*'.
   */
  targetOrigin?: string;
  /**
   * Allowlist of acceptable parent origins, matching `createAppBridge`.
   * When supplied, a resolved origin outside the list is rejected and no
   * message is posted.
   */
  allowedParentOrigins?: readonly string[];
}

export function UrlSync({
  pathname,
  search = '',
  onDeepLink,
  onNavigate,
  targetOrigin,
  allowedParentOrigins,
}: UrlSyncProps) {
  // Read at delivery time by the mount-only subscription below, which must not
  // close over a stale pathname or a stale inline-arrow callback.
  const latest = useRef({ pathname, search, onNavigate });
  latest.current = { pathname, search, onNavigate };

  // ── INBOUND: the merchant clicked one of this app's host sidebar links ────
  //
  // Gated on `onNavigate` being present AT MOUNT. Subscribing is what announces
  // `hostNavigate: true`, and the host suppresses the click on the strength of
  // that announcement — so claiming the capability without a handler would hang
  // the merchant on a dead link. No handler, no announcement, ordinary
  // full-page navigation.
  //
  // Deps are `[]` on purpose. Callers pass inline arrows, whose identity changes
  // every render; keying on the callback would unsubscribe and resubscribe
  // continuously, flapping the capability flag at the host. One stable
  // subscription for the component's lifetime, kept current by the ref above.
  const subscribes = onNavigate !== undefined;
  useEffect(() => {
    if (typeof window === 'undefined' || window.self === window.top) return;
    if (!subscribes) return;

    return subscribeHostNavigation(getBridge(), {
      push: (path) => latest.current.onNavigate?.(path),
      currentUrl: () => `${latest.current.pathname}${latest.current.search}`,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [subscribes]);
  // Deep-link once on mount: restore the page AND the view state that was on
  // it. Restoring only the path used to drop filters/search on reload, which
  // made a shared link land on the right page with the wrong contents.
  useEffect(() => {
    if (typeof window === 'undefined' || window.self === window.top) return;

    const hostParams = new URLSearchParams(window.location.search);
    const path = hostParams.get('path');
    if (path === null || !path.startsWith('/')) return;

    // Everything the host is carrying that belongs to the app comes back too.
    const restored: Array<[string, string]> = [];
    hostParams.forEach((value, key) => {
      if (key !== 'path') restored.push([key, value]);
    });

    const target = buildAppUrl(path, restored);
    const current = `${pathname}${search}`;
    if (target !== '/' && target !== current) {
      onDeepLink?.(target);
    }
    // Mount-only: re-running would fight the user's own navigation.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Push path + shareable params to the host.
  //
  // SECURITY: this used to post with targetOrigin '*', which broadcasts the
  // merchant's in-app navigation to any frame listening on the page. We now
  // resolve the parent origin and fail closed — no resolvable (and
  // allowlisted) origin means no message.
  useEffect(() => {
    if (typeof window === 'undefined' || window.self === window.top) return;

    const origin =
      targetOrigin ?? resolveParentOrigin(window.location.search, allowedParentOrigins);

    if (origin === null || origin === undefined || origin === '' || origin === '*') return;

    try {
      window.parent.postMessage(
        {
          type: 'FLASHMANDU_BRIDGE:PATH_CHANGE',
          payload: buildPathChangePayload(pathname, search),
        },
        origin,
      );
    } catch { /* parent unreachable */ }
  }, [pathname, search, targetOrigin, allowedParentOrigins]);

  return null;
}
