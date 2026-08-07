# @flashmandu/app-bridge

The **in-iframe App Bridge SDK** for Flashmandu embedded apps. This is the npm
package an app author installs (`@flashmandu/app-bridge`) to drive their
embedded app from inside the platform's iframe.

The SDK is the iframe-side counterpart to the platform's host-side postMessage
listener. The app never holds its own `api_token` in the browser — every API
call is postMessaged to the parent shell, which proxies it through the
same-origin `/api/apps/proxy` route under the **merchant's** session.

- Zero runtime dependencies.
- ESM + CJS + TypeScript declarations.
- ~3KB minified, browser-only.

## Install

```bash
npm install @flashmandu/app-bridge
```

Works in any modern browser (Chromium, Firefox, Safari). No Node runtime.

## Quickstart

```ts
import { createAppBridge } from '@flashmandu/app-bridge';

// Reads signed params from window.location.search, posts READY to the parent,
// and resolves once the parent posts CONTEXT back.
const bridge = createAppBridge();

const ctx = await bridge.ready();
console.log('Embedded in', ctx.origin, 'as app', ctx.appId);

// Read through the proxy — the host authenticates server-side.
const me = await bridge.request({ method: 'GET', path: 'me' });
const orders = await bridge.request({
  method: 'GET',
  path: 'orders',
  body: { location_ids: [1, 2] },
});

bridge.toast('Saved!', 'success');
bridge.setTitle('Orders · My App');
```

## What it does

On `createAppBridge()`:

1. Reads `session_token`, `app_id`, `profile_id`, `target`, and
   `parent_origin` from `window.location.search` (the embed shell stamps these
   when it mounts the iframe).
2. Resolves the parent origin (signed `parent_origin` param first, then
   `document.referrer`, then the `allowedParentOrigins` option).
3. Posts `FLASHMANDU_BRIDGE:READY` to `window.parent`, scoped to the resolved
   origin.
4. Listens for `FLASHMANDU_BRIDGE:CONTEXT` from the parent — `ready()`
   resolves with the resulting `AppContext`.

After `ready()`:

- `request({ method, path, body })` posts a `FLASHMANDU_BRIDGE:REQUEST` with a
  monotonic `id` and returns a Promise that settles when the parent posts the
  matching `FLASHMANDU_BRIDGE:RESPONSE` (correlated by `id`). A transport
  failure comes back as `{ status: 0 }`.
- `toast(message, variant?)`, `navigate(href)`, and `setTitle(title)` are
  fire-and-forget notifications to the shell.
- `setSidebarLinks(links)` registers the app's own navigation in the host
  sidebar, and `onHostNavigate(listener)` receives the merchant's clicks on
  those links so the app can route internally instead of reloading the whole
  admin page. **Subscribe if you call `setSidebarLinks`** — see below.

## Security

- Inbound messages are accepted **only** from `window.parent` and **only** when
  `event.origin` matches the resolved parent origin. Any other source is
  silently dropped.
- If no parent origin can be resolved, the transport fails closed: no inbound
  message is ever accepted, so `ready()` never settles. The app should fail
  gracefully when it is loaded outside the platform embed.
- Outbound postMessage always targets the resolved origin — never `"*"`.

## Message protocol

Mirrors the host-side listener at
`packages/flashmandu/apps/resources/js/app-bridge-host.ts` in the platform
repo. Wire format is `{ type: string, payload?: ... }`.

| Direction        | `type`                          | Payload                                                            |
| ---------------- | ------------------------------- | ------------------------------------------------------------------ |
| iframe → parent  | `FLASHMANDU_BRIDGE:READY`       | `{ token, appId, sdkVersion }`                                     |
| parent → iframe  | `FLASHMANDU_BRIDGE:CONTEXT`     | `{ origin, profile?, locale?, tz?, scopes?, target?, expiresAt? }` |
| iframe → parent  | `FLASHMANDU_BRIDGE:REQUEST`     | `{ id, method: 'GET'\|'POST', path, body? }`                       |
| parent → iframe  | `FLASHMANDU_BRIDGE:RESPONSE`    | `{ id, status, body }`                                             |
| iframe → parent  | `TOAST`                         | `{ message, variant? }`                                            |
| iframe → parent  | `NAVIGATE`                      | `{ href }`                                                         |
| iframe → parent  | `FLASHMANDU_BRIDGE:SET_TITLE`   | `{ title }`                                                        |
| iframe → parent  | `FLASHMANDU_BRIDGE:SET_SIDEBAR_LINKS` | `{ links: [{ label, path, icon? }] }`                        |
| parent → iframe  | `FLASHMANDU_BRIDGE:HOST_NAVIGATE` | `{ path }`                                                       |
| iframe → parent  | `FLASHMANDU_BRIDGE:HOST_NAVIGATE_ACK` | `{ path }`                                                   |

### Host-driven navigation and the ack

`HOST_NAVIGATE` / `HOST_NAVIGATE_ACK` are a **request/ack pair, not a
notification.** The host suppresses the merchant's sidebar click, rewrites the
address bar with `pushState`, and moves the active highlight *before* it posts —
so if the message never lands, the chrome says "Members" while the iframe still
shows the old page, and because the URL already changed, clicking the same link
again does nothing. The ack is the host's only evidence that the navigation
actually happened; absence of one is its cue to recover.

The SDK posts `HOST_NAVIGATE_ACK` only when **all** of the following hold:

1. The message came from the parent window on the resolved parent origin.
2. `path` is a string and is app-relative — a leading `/`, but not `//` or `/\`,
   both of which browsers and routers resolve as off-site absolute URLs.
3. **At least one `onHostNavigate` listener is registered**, and was invoked.

Condition 3 is deliberate: an app that imported the SDK but never subscribed
must be distinguishable from one that routed successfully, so it gets silence.
A listener that throws still acks — it received the path, and its own failure is
not something the host can fix. The ack is sent once per accepted message,
regardless of how many listeners are subscribed, and always targets the resolved
parent origin.

> **Quirk.** The host uses the unprefixed `TOAST` and `NAVIGATE` tokens (not
> `FLASHMANDU_BRIDGE:TOAST` / `:NAVIGATE`), and the TOAST/NAVIGATE payload
> field names are `variant` and `href` respectively. This SDK mirrors that
> exactly — changing it here would silently break toasts and navigation.

## Proxied paths

`request()` calls go through `/api/apps/proxy` on the platform (see
`BridgeProxyController`). The current allowlist:

| Method | Path           | Purpose                                            |
| ------ | -------------- | -------------------------------------------------- |
| GET    | `me`           | App identity + granted scopes.                     |
| GET    | `orders`       | Orders for the given `location_ids` body.          |
| GET    | `catalog/items`  | Catalog items by `ids` or `term` search.        |
| GET    | `parties`      | Parties by `ids` or `term` search.                 |
| GET    | `locations`    | Locations by `ids` or `kind`.                      |

Writes are not on this endpoint — they go through GraphQL under their own
scope checks. A path not in the allowlist returns `{ status: 404 }`.

## API

```ts
interface AppBridge {
  readonly context: AppContext | null;
  ready(): Promise<AppContext>;
  toast(message: string, variant?: 'default'|'success'|'error'|'warning'|'info'): void;
  navigate(href: string): void;
  setTitle(title: string): void;
  setSidebarLinks(links: Array<{ label: string; path: string; icon?: string }>): void;
  onHostNavigate(listener: (path: string) => void): () => void;
  request(input: { method: 'GET'|'POST'; path: string; body?: Record<string, unknown> | null }): Promise<{ status: number; body: unknown }>;
  on(event: 'context'|'ready'|'destroy', listener: (payload: unknown) => void): () => void;
  destroy(): void;
}
```

## Developing the SDK

```bash
npm install
npm run typecheck   # tsc --noEmit
npm run build       # tsup -> dist/{index.js,index.cjs,index.d.ts}
npm test            # vitest run
```

## Releasing

```bash
bin/release.sh 0.1.0
```

Bumps `package.json`, tags `v0.1.0`, and pushes. The Release workflow builds,
publishes to npm via OIDC trusted publishing, and opens the GitHub release.

## License

Proprietary. © Flashmandu.
