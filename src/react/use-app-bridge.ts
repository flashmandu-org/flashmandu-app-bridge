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