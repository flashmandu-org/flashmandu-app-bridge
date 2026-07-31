/**
 * @flashmandu/app-bridge/react — BridgeBootstrap component.
 *
 * Seeds the embedded profile id into sessionStorage from the signed embed URL
 * (?profile_id=…) on every page mount. Renders nothing.
 */
'use client';

import { useEffect } from 'react';

const PROFILE_STORAGE_KEY = 'fm:embed:profile_id';

export function BridgeBootstrap() {
  useEffect(() => {
    if (typeof window === 'undefined' || window.self === window.top) return;
    const pid = new URLSearchParams(window.location.search).get('profile_id');
    if (pid && /^[0-9]+$/.test(pid)) {
      try {
        window.sessionStorage.setItem(PROFILE_STORAGE_KEY, pid);
      } catch { /* ignore */ }
    }
  }, []);

  return null;
}