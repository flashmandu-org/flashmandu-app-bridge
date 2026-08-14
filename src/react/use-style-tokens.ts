/**
 * `useStyleTokens` — the React face of a Style Surface's resolved values.
 *
 * READ THIS BEFORE REACHING FOR IT
 * ---------------------------------
 * Most apps should NOT need this hook. `createAppBridge()` auto-applies every
 * Style Surface push as a CSS custom property on the document root (see
 * `style.ts` / `CreateAppBridgeOptions.applyStyleTokens`), so anything styled
 * with `var(--x, <default>)` already follows the merchant's edits with no
 * JavaScript at all — including live, while they drag a builder slider.
 *
 * This hook is for the residue CSS cannot reach: a WebGL/canvas surface (the
 * tours panorama viewer is the motivating case), or handing a resolved colour
 * to a non-DOM renderer. Reach for it only when `var()` genuinely cannot get
 * there — `@flashmandu/app-bridge-ui`'s `useStyleSurface(surfaceKey)` wraps
 * this with per-surface default-filling for exactly that situation.
 *
 * `useSyncExternalStore`, same reasoning as `useColorScheme`: an explicit
 * empty-object SERVER snapshot keeps hydration from warning, and the resolved
 * client value lands on the very next commit.
 */
'use client';

import { useCallback, useSyncExternalStore } from 'react';
import { getBridge } from './use-app-bridge.js';

/** No merchant, no window, on the server — an empty map is the honest answer. */
const SERVER_SNAPSHOT: Record<string, string> = {};

/**
 * The currently known Style Surface token map, merged from `CONTEXT` and every
 * `STYLE_TOKENS` push since. Re-renders on every update.
 */
export function useStyleTokens(): Record<string, string> {
  const subscribe = useCallback((onChange: () => void): (() => void) => {
    if (typeof window === 'undefined') return () => undefined;
    return getBridge().onStyleTokens(onChange);
  }, []);

  const getSnapshot = useCallback((): Record<string, string> => {
    if (typeof window === 'undefined') return SERVER_SNAPSHOT;
    return getBridge().styleTokens;
  }, []);

  return useSyncExternalStore(subscribe, getSnapshot, () => SERVER_SNAPSHOT);
}
