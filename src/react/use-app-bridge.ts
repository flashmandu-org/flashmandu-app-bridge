/**
 * @flashmandu/app-bridge/react — React hooks for the App Bridge SDK.
 *
 * Provides useAppBridge, useProfileId, useToast, useBridgeTitle hooks
 * that work both embedded (inside Flashmandu iframe) and standalone (dev).
 */
'use client';

import { useEffect, useMemo, useState } from 'react';
import {
  createAppBridge,
  type AppBridge,
  type AppContext,
  type ToastVariant,
} from '../index.js';

const DEV_PROFILE_ID = 1;
const BRIDGE_TIMEOUT_MS = 1500;
const PROFILE_STORAGE_KEY = 'fm:embed:profile_id';

let bridgeSingleton: AppBridge | null = null;

/** Shared singleton bridge instance for this document. */
export function getBridge(): AppBridge {
  if (!bridgeSingleton) bridgeSingleton = createAppBridge();
  return bridgeSingleton;
}

/**
 * Where a host-driven navigation should land.
 *
 * `currentUrl` is read at DELIVERY time, not at subscribe time: the
 * subscription is mount-only (see below), so it must not close over a stale
 * pathname. Adapters pass a ref-backed getter.
 */
export interface HostNavigationTarget {
  /** Perform the in-app navigation. */
  push: (path: string) => void;
  /** The app's current `pathname + search`, as it is right now. */
  currentUrl: () => string;
}

/**
 * Route the app when the merchant clicks one of its host sidebar links.
 *
 * Split out of the adapter so the behaviour is testable without a React
 * renderer, and so any adapter (Next today, others later) wires it the same
 * way. Returns the bridge's unsubscribe handle unchanged — an adapter MUST
 * return it from its effect, both so a remount does not stack listeners and so
 * teardown triggers the `hostNavigate: false` capability announcement.
 *
 * Subscribing is what announces `hostNavigate: true`, which is what unlocks
 * host-side click suppression — so adapters subscribe on MOUNT, never lazily on
 * first navigation, or the merchant's early clicks are all full page loads.
 *
 * The same-URL check is a courtesy, not a loop-breaker: routing here makes the
 * app post PATH_CHANGE back to the host, but the host answers PATH_CHANGE by
 * rewriting its own address bar and never by posting HOST_NAVIGATE, so there is
 * no cycle to break. What it does avoid is a pointless `push()` to the page the
 * app is already on — a scroll reset or refetch in some routers.
 */
export function subscribeHostNavigation(
  bridge: AppBridge,
  target: HostNavigationTarget,
): () => void {
  return bridge.onHostNavigate((path: string): void => {
    if (path === target.currentUrl()) return;
    target.push(path);
  });
}

function resolveEmbeddedProfileId(): number | null {
  if (typeof window === 'undefined') return null;
  if (window.self === window.top) return null;

  const fromUrl = new URLSearchParams(window.location.search).get('profile_id');
  if (fromUrl && /^[0-9]+$/.test(fromUrl)) {
    const pid = Number(fromUrl);
    try {
      window.sessionStorage.setItem(PROFILE_STORAGE_KEY, String(pid));
    } catch { /* ignore */ }
    return pid;
  }

  try {
    const cached = window.sessionStorage.getItem(PROFILE_STORAGE_KEY);
    if (cached && /^[0-9]+$/.test(cached)) return Number(cached);
  } catch { /* ignore */ }
  return null;
}

export type BridgeStatus =
  | { status: 'loading' }
  | { status: 'ready'; profileId: number; embedded: boolean; ctx: AppContext };

/**
 * Resolve the bridge session once. Returns profileId + bridge instance.
 */
export function useAppBridge(): BridgeStatus & { bridge: AppBridge } {
  const [state, setState] = useState<BridgeStatus>({ status: 'loading' });
  const bridge = useMemo(() => getBridge(), []);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const embedded = window.self !== window.top;
    const profileId = resolveEmbeddedProfileId();

    if (embedded && profileId !== null) {
      setState({ status: 'ready', profileId, embedded: true, ctx: bridge.context as AppContext });
      bridge.ready().catch(() => {});
      return;
    }

    if (!embedded) {
      setState({ status: 'ready', profileId: DEV_PROFILE_ID, embedded: false, ctx: bridge.context as AppContext });
      return;
    }

    let cancelled = false;
    const fallback = window.setTimeout(() => {
      if (!cancelled) setState({ status: 'ready', profileId: DEV_PROFILE_ID, embedded: false, ctx: bridge.context as AppContext });
    }, BRIDGE_TIMEOUT_MS);

    bridge
      .ready()
      .then((ctx) => {
        if (cancelled) return;
        window.clearTimeout(fallback);
        const pid = (ctx as AppContext & { profileId?: number }).profileId;
        setState({
          status: 'ready',
          profileId: typeof pid === 'number' ? pid : DEV_PROFILE_ID,
          embedded: typeof pid === 'number',
          ctx,
        });
      })
      .catch(() => {
        if (cancelled) return;
        window.clearTimeout(fallback);
        setState({ status: 'ready', profileId: DEV_PROFILE_ID, embedded: false, ctx: bridge.context as AppContext });
      });

    return () => {
      cancelled = true;
      window.clearTimeout(fallback);
    };
  }, [bridge]);

  return { ...state, bridge };
}

/** Profile-id-only view of useAppBridge. */
export function useProfileId(): BridgeStatus {
  const b = useAppBridge();
  if (b.status === 'loading') return { status: 'loading' };
  return { status: 'ready', profileId: b.profileId, embedded: b.embedded, ctx: b.ctx };
}

/** Toast helper — uses host shell when embedded, console otherwise. */
export function useToast(): (message: string, variant?: ToastVariant) => void {
  return (message, variant = 'default') => {
    const bridge = bridgeSingleton;
    if (bridge && typeof window !== 'undefined' && window.self !== window.top) {
      bridge.toast(message, variant);
    } else {
      // eslint-disable-next-line no-console
      console.log(`[toast:${variant}]`, message);
    }
  };
}

/** Keep the host's tab title in sync with the in-app page. */
export function useBridgeTitle(title: string): void {
  useEffect(() => {
    if (typeof window === 'undefined' || window.self === window.top) return;
    bridgeSingleton?.setTitle(title);
  }, [title]);
}