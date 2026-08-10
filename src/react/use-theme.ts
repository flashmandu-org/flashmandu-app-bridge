/**
 * `useColorScheme` — the React face of the host's theme.
 *
 * READ THIS BEFORE REACHING FOR IT
 * --------------------------------
 * Most apps should NOT need this hook. The theme is already on the document as
 * `data-fm-theme` / `.dark` before the first paint (see `themeBootstrapScript`
 * and `<BridgeBootstrap />`), so anything styled with Bridge UI tokens, or with
 * Tailwind's `dark:` variant, follows the merchant with no JavaScript at all —
 * including through a live change, because the attribute is rewritten in place.
 *
 * The hook is for the residue CSS cannot express: picking a different logo
 * asset, handing a colour to a canvas or chart library, choosing a map style.
 * Rendering whole branches off it instead of styling them is how an app ends up
 * with a hydration mismatch AND a flash.
 *
 * `useSyncExternalStore` rather than `useState` + `useEffect` on purpose: it
 * gives React an explicit SERVER snapshot, so the hydration pass agrees with
 * the server-rendered HTML instead of warning, and the real value arrives on
 * the commit right after.
 */
'use client';

import { useCallback, useSyncExternalStore } from 'react';
import type { ColorScheme } from '../types.js';
import { getBridge } from './use-app-bridge.js';

/**
 * The server has no merchant and no window, so it cannot know the scheme.
 * Light is the honest default and matches the un-themed token layer; the
 * client corrects it on the first commit, while the DOM attribute — set by the
 * inline bootstrap during parse — was never wrong in the first place.
 */
const SERVER_SNAPSHOT: ColorScheme = 'light';

/** The merchant's admin colour scheme, following live changes. */
export function useColorScheme(): ColorScheme {
  const subscribe = useCallback((onChange: () => void): (() => void) => {
    if (typeof window === 'undefined') return () => undefined;
    return getBridge().onTheme(onChange);
  }, []);

  const getSnapshot = useCallback((): ColorScheme => {
    if (typeof window === 'undefined') return SERVER_SNAPSHOT;
    return getBridge().theme;
  }, []);

  return useSyncExternalStore(subscribe, getSnapshot, () => SERVER_SNAPSHOT);
}

/** True when the merchant's admin is in dark mode. Sugar over the above. */
export function useIsDarkMode(): boolean {
  return useColorScheme() === 'dark';
}
