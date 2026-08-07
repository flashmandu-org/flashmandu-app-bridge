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
| parent → iframe  | `FLASHMANDU_BRIDGE:HOST_NAVIGATE` | `{ id, path }`                                                   |
| iframe → parent  | `FLASHMANDU_BRIDGE:HOST_NAVIGATE_ACK` | `{ id, path }`                                               |
| iframe → parent  | `FLASHMANDU_BRIDGE:SET_CAPABILITIES` | `{ capabilities: { hostNavigate } }`                          |

### Host-driven navigation and the ack

`HOST_NAVIGATE` / `HOST_NAVIGATE_ACK` are a **request/ack pair, not a
notification.** The host suppresses the merchant's sidebar click, rewrites the
address bar with `pushState`, and moves the active highlight *before* it posts —
so if the message never lands, the chrome says "Members" while the iframe still
shows the old page, and because the URL already changed, clicking the same link
again does nothing. The ack is the host's only evidence that the navigation
actually happened; absence of one is its cue to recover.

**The pair is correlated by `id`, not by path.** The host allocates the `id`
from its own counter (it is unrelated to, and never drawn from, the
REQUEST/RESPONSE sequence), and the SDK echoes it back verbatim in the ack. This
is what lets the host distinguish two rapid navigations to the *same* path — a
double-click, or link → back → same link — where a late ack for the first would
otherwise be read as the ack for the second. `path` rides along in the ack for
debugging; it is not the correlation key.

The SDK posts `HOST_NAVIGATE_ACK` only when **all** of the following hold:

1. The message came from the parent window on the resolved parent origin.
2. `id` is a finite number. A missing, `null`, string, `NaN` or `Infinity` id is
   a malformed message and is dropped exactly like a bad origin — the SDK will
   not invent an id, because an ack the host cannot match is worse than the
   silence it already knows how to handle.
3. `path` is a string and is app-relative — a leading `/`, but not `//` or `/\`,
   both of which browsers and routers resolve as off-site absolute URLs.
4. **At least one `onHostNavigate` listener is registered**, and was invoked.

Condition 4 is deliberate: an app that imported the SDK but never subscribed
must be distinguishable from one that routed successfully, so it gets silence.
A listener that throws still acks — it received the path, and its own failure is
not something the host can fix. The ack is sent once per accepted message,
regardless of how many listeners are subscribed, and always targets the resolved
parent origin.

The listener itself receives only the `path`: the `id` is transport bookkeeping
between the host and the SDK, and the app never has to handle it.

### Capability announcement — may the host suppress a click at all?

**The host must not suppress a sidebar click until the app has announced
`hostNavigate: true`.** Without an announcement the link performs an ordinary
full-page navigation, which is exactly what apps on older SDKs already do — so
they keep working unchanged rather than snapping back.

The ack alone cannot carry this. An ack only arrives *after* a click the host
already suppressed, so the first click of every session would have to be either
unsuppressed (no persistent shell until click two) or suppressed on faith (a
hang for an app that never subscribed). Nor can the host probe by sending a
synthetic `HOST_NAVIGATE` for the app's current path: that is a real navigation
instruction, and routers treat it inconsistently — a no-op in some, a scroll
reset or a refetch in others. **The host must never cause a navigation it did
not mean.** So the app announces instead.

`SET_CAPABILITIES` is sent when the capability set **changes**:

- when the **first** `onHostNavigate` listener subscribes → `hostNavigate: true`
- when the **last** one is removed, including on `destroy()` → `hostNavigate: false`

It is deliberately **not** sent at construction — a React app subscribes in an
effect after mount, so a boot-time announcement would always claim the wrong
thing — and not on the second or subsequent subscribe. A missing announcement
and `{ hostNavigate: false }` mean the same thing to the host.

`capabilities` is an object rather than a bare boolean so that the next
capability (an ack for save-bar state, say) can be added as a field instead of a
new message type. Treat an absent field as unsupported.

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

The host-navigation payload types are exported too, for hosts and for apps that
assert on the wire format. Both carry the correlation `id`; the SDK echoes the
one it was given:

```ts
interface HostNavigatePayload    { id: number; path: string }  // parent → iframe
interface HostNavigateAckPayload { id: number; path: string }  // iframe → parent
interface BridgeCapabilities     { hostNavigate: boolean }
interface SetCapabilitiesPayload { capabilities: BridgeCapabilities }  // iframe → parent
```

`SidebarLink` and `SetSidebarLinksPayload` are exported alongside them.

## Wire contract

The authoritative envelope shapes for the host-navigation trio. The host side
(`packages/flashmandu/apps/resources/js/app-bridge-host.ts`) should be checked
against this table directly — there is no shared fixture yet, so this is the one
place both repos agree on.

```jsonc
// parent → iframe. The host suppressed a sidebar click and is asking the app
// to route. `id` is the host's own counter value: a non-negative integer.
{
  "type": "FLASHMANDU_BRIDGE:HOST_NAVIGATE",
  "payload": { "id": 7, "path": "/members" }
}

// iframe → parent. An app listener received that path. Absence means it did
// not route — the host must recover.
{
  "type": "FLASHMANDU_BRIDGE:HOST_NAVIGATE_ACK",
  "payload": { "id": 7, "path": "/members" }
}

// iframe → parent. Sent on change only: first subscribe, and last unsubscribe.
{
  "type": "FLASHMANDU_BRIDGE:SET_CAPABILITIES",
  "payload": { "capabilities": { "hostNavigate": true } }
}
```

An inbound `HOST_NAVIGATE` is **dropped silently, with no ack**, unless all of:

| Field       | Requirement                                                          |
| ----------- | -------------------------------------------------------------------- |
| `event.origin` | Exactly the resolved parent origin. Unresolved origin ⇒ drop all. |
| `event.source` | Exactly `window.parent`.                                          |
| `payload.id`   | `Number.isInteger(id) && id >= 0`. No `NaN`, `Infinity`, `'7'`, `7.5`, `-1`. |
| `payload.path` | String starting `/`, but not `//` or `/\`.                        |

Plus: at least one `onHostNavigate` listener must be registered, or the message
is dropped and no ack is sent.

Outbound messages always target the resolved parent origin, never `"*"`. The
`id` in an ack is echoed verbatim from the navigate — the SDK never allocates
it, and in particular never draws it from the REQUEST/RESPONSE counter.

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
