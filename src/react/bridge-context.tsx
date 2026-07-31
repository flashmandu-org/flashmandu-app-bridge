/**
 * @flashmandu/app-bridge/react — BridgeContext component.
 *
 * Resolves the in-iframe App Bridge context and renders it.
 * Browsed standalone, it surfaces that gracefully.
 */
'use client';

import { useEffect, useState } from 'react';

type State =
  | { status: 'loading' }
  | { status: 'ready'; ctx: { origin: string; appId: string | null; profileId: string | null; target: string | null; locale: string | null; scopes: readonly string[] } }
  | { status: 'standalone'; reason: string };

export function BridgeContext() {
  const [state, setState] = useState<State>({ status: 'loading' });

  useEffect(() => {
    if (typeof window === 'undefined') return;

    if (window.self === window.top) {
      setState({ status: 'standalone', reason: 'Running standalone (not embedded).' });
      return;
    }

    let cancelled = false;
    import('../index.js').then(({ createAppBridge }) => {
      if (cancelled) return;
      const bridge = createAppBridge();
      bridge.ready().then((ctx) => {
        if (!cancelled) setState({
          status: 'ready',
          ctx: {
            origin: ctx.origin,
            appId: ctx.appId,
            profileId: ctx.profileId as string | null,
            target: ctx.target,
            locale: ctx.locale,
            scopes: ctx.scopes,
          },
        });
      }).catch((err: unknown) => {
        if (!cancelled) setState({ status: 'standalone', reason: err instanceof Error ? err.message : String(err) });
      });
    }).catch((err: unknown) => {
      if (!cancelled) setState({ status: 'standalone', reason: err instanceof Error ? err.message : String(err) });
    });

    return () => { cancelled = true; };
  }, []);

  if (state.status === 'loading') return <p className="fm-muted">Loading…</p>;
  if (state.status === 'standalone') return <p className="fm-muted" role="note">{state.reason}</p>;

  const { ctx } = state;
  return (
    <dl className="fm-kv">
      <dt>Origin</dt>
      <dd>{ctx.origin}</dd>
      <dt>App ID</dt>
      <dd>{ctx.appId ?? '—'}</dd>
      <dt>Profile</dt>
      <dd>{ctx.profileId ?? '—'}</dd>
      <dt>Target</dt>
      <dd>{ctx.target ?? '—'}</dd>
      <dt>Locale</dt>
      <dd>{ctx.locale ?? '—'}</dd>
      <dt>Scopes</dt>
      <dd>
        {ctx.scopes.length ? ctx.scopes.map((s) => <span key={s} className="fm-chip">{s}</span>) : <span className="fm-muted">(none)</span>}
      </dd>
    </dl>
  );
}