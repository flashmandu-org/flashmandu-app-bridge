/**
 * @flashmandu/app-bridge/react — BridgeBootstrap component.
 *
 * Two jobs, both of which have to happen as early in the document as possible:
 *
 *  1. Stamp the merchant's colour scheme on `<html>` BEFORE the first paint,
 *     via an inline script in the server-rendered HTML, and then keep it in
 *     sync with the host for the rest of the session.
 *  2. Seed the embedded profile id into sessionStorage from the signed embed
 *     URL (`?profile_id=…`).
 *
 * WHY THE INLINE SCRIPT, AND WHY IT CANNOT BE AN EFFECT
 * -----------------------------------------------------
 * An effect runs after hydration; a module runs after its bundle downloads;
 * the bridge handshake runs after a postMessage round trip. All three are
 * after the browser has already painted, so all three produce the same visible
 * artefact — one or more frames of the wrong theme, which on a dark-mode
 * merchant is a white flash in a dark admin.
 *
 * An inline script placed inside `<body>`, ahead of the app's content, runs
 * DURING HTML parsing. The browser has not painted yet (it is still blocked on
 * the stylesheets in `<head>`), so by the time anything is on screen the
 * document already carries the right attribute and the token layer has already
 * resolved to the right values. There is no first frame in the wrong theme to
 * repaint, which is why this component must stay the first child of `<body>`.
 *
 * `dangerouslySetInnerHTML` is the only way to emit a script React will not
 * escape. The content is a fixed string from this package with no interpolated
 * input, so there is nothing user-controlled to inject.
 */
'use client';

import { useEffect } from 'react';
import { applyColorScheme, themeBootstrapScript } from '../theme.js';
import { getBridge } from './use-app-bridge.js';

const PROFILE_STORAGE_KEY = 'fm:embed:profile_id';

export function BridgeBootstrap() {
  useEffect(() => {
    if (typeof window === 'undefined') return;

    /*
     * Re-apply on mount as well as in the inline script. Belt and braces for
     * two real cases: an app that forgot to render this component in its
     * server HTML (SPA, no SSR — it then costs one repaint instead of being
     * broken), and a client-side route change in a framework that re-runs the
     * document shell.
     */
    const bridge = getBridge();
    applyColorScheme(bridge.theme);

    // Live changes: the merchant toggles their admin theme and the host posts
    // THEME. Rewriting the attribute is enough — the token layer does the rest
    // with no re-render of the React tree.
    const unsubscribe = bridge.onTheme((next) => {
      applyColorScheme(next);
    });

    if (window.self !== window.top) {
      const pid = new URLSearchParams(window.location.search).get('profile_id');
      if (pid && /^[0-9]+$/.test(pid)) {
        try {
          window.sessionStorage.setItem(PROFILE_STORAGE_KEY, pid);
        } catch { /* ignore */ }
      }
    }

    return unsubscribe;
  }, []);

  return (
    <script
      // eslint-disable-next-line react/no-danger -- fixed package string, no interpolation
      dangerouslySetInnerHTML={{ __html: themeBootstrapScript() }}
      suppressHydrationWarning
    />
  );
}
