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

import { useEffect } from 'react';
import { resolveParentOrigin } from '../transport.js';
import { buildAppUrl, buildPathChangePayload } from '../url-state.js';

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
  targetOrigin,
  allowedParentOrigins,
}: UrlSyncProps) {
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
