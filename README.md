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
- ~5KB minified+gzipped for the core entry, browser-only. Modal/picker and the
  mock host are separate entries that tree-shake out when unused.

**Protocol v2 — no backwards compatibility.** `SET_TITLE` is gone, folded into
`SET_PAGE`. `setTitle()` and the `useBridgeTitle` hook are deleted with it.

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
// REST, over the host proxy — always available.
const me = await bridge.request({ method: 'GET', path: 'me' });

// GraphQL, straight to the platform — when the host announces directApi.
const { body } = await bridge.graphql(
  'query Orders($ids: [ID!]) { orders(locationIds: $ids) { id total } }',
  { ids: ['1', '2'] },
);

bridge.toast('Saved!', 'success');

// Page chrome: breadcrumbs, command-bar actions, dirty state — one message.
bridge.setPage({
  title: 'Orders',
  crumbs: [{ label: 'Orders', path: '/orders' }, { label: '#1043' }],
  actions: [{ id: 'save', label: 'Save', variant: 'primary', icon: 'check' }],
  dirty: false,
});
bridge.onAction((id) => { if (id === 'save') save(); });

// Progress bar under the host command bar.
bridge.loading(true);
try { await save(); } finally { bridge.loading(false); }

// Toast with an action button.
bridge.toast('Order saved', { variant: 'success', action: { label: 'View', path: '/orders/1043' } });
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
- `toast(message, variantOrOptions?)` and `navigate(href)` are
  fire-and-forget notifications to the shell.
- `setSidebarLinks(links)` registers the app's own navigation in the host
  sidebar, and `onHostNavigate(listener)` receives the merchant's clicks on
  those links so the app can route internally instead of reloading the whole
  admin page. Next apps get this wired for them; React and everyone else
  React and Next apps get this from `<UrlSync />` — see
  [Framework adapters](#framework-adapters).

## Framework adapters

There are two `UrlSync` components. Both wire host navigation in both
directions; they differ in whether you have to hand them a router:

| Import                          | Address bar (outbound) | Sidebar clicks (inbound)                     |
| ------------------------------- | ---------------------- | --------------------------------------------- |
| `@flashmandu/app-bridge/next`   | ✅ automatic           | ✅ **automatic**                              |
| `@flashmandu/app-bridge/react`  | ✅ automatic           | ✅ **when you pass `onNavigate`**             |

### Next apps — `<UrlSync />` wires both directions

**Mounting `<UrlSync />` from `@flashmandu/app-bridge/next` wires host
navigation in both directions: it mirrors the app's route into the platform
address bar, and it subscribes to `onHostNavigate` so the merchant's sidebar
clicks route inside the app — no per-app wiring, no manual
`bridge.onHostNavigate(...)` call.**

```tsx
// app/layout.tsx
import { UrlSync } from '@flashmandu/app-bridge/next';

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html>
      <body>
        <UrlSync />
        {children}
      </body>
    </html>
  );
}
```

Mount it once, high in the tree, and leave it mounted. Specifically it:

- deep-links on mount, restoring the path **and** the shareable query state the
  host is carrying in `?path=`;
- posts `PATH_CHANGE` as the app navigates, so the address bar tracks the app;
- subscribes to `onHostNavigate` on mount and routes with `router.push()`.

That third point is why mounting matters early: **subscribing is what announces
the `hostNavigate` capability, and the host will not suppress a sidebar click
until it has seen that announcement.** An app that mounts `<UrlSync />` late, or
not at all, keeps today's full-page navigation — correct, but slow, and with no
error to tell you why.

The subscription is mount-only and its unsubscribe is returned from the effect,
so a remount does not stack listeners and an unmount correctly announces
`hostNavigate: false`. Routing in response to a host navigate makes the app post
`PATH_CHANGE` back, which is harmless: the host answers `PATH_CHANGE` by
rewriting its address bar and never by posting `HOST_NAVIGATE`, so there is no
cycle. A navigate to the URL the app is already on is skipped rather than
pushed.

> **In dev, expect `true → false → true`.** React Strict Mode mounts effects
> twice, so a development page load produces a subscribe, an unsubscribe and a
> resubscribe — three capability announcements where production sends one. This
> is not a bug, and it is exactly why the host must treat `SET_CAPABILITIES` as
> idempotent state rather than an event to count.

### React apps — `<UrlSync />` needs one prop

The router-agnostic component at `@flashmandu/app-bridge/react` is router-
agnostic by design: it takes `pathname` and `search` as props, so it has no
router of its own to push to. **Pass `onNavigate` and it subscribes to
`onHostNavigate` for you, exactly as the Next adapter does.**

```tsx
import { UrlSync } from '@flashmandu/app-bridge/react';

<UrlSync
  pathname={location.pathname}
  search={location.search}
  onDeepLink={(path) => myRouter.replace(path)}
  onNavigate={(path) => myRouter.push(path)}
/>
```

`onNavigate` is separate from `onDeepLink` because the two are different
navigations: a deep-link restore corrects the current history entry
(`replace`), while a sidebar click is a new entry the merchant can go back from
(`push`).

**Omit `onNavigate` and the component does not subscribe — deliberately.**
Subscribing announces the capability, and announcing it with nothing to handle
the navigation would leave the merchant on a dead link, which is worse than the
full-page navigation you get by leaving it off. So: pass it unconditionally, or
not at all. It is read at mount to decide; the function itself may be a fresh
inline arrow on every render.

### Any other framework

Subscribe directly, following the same two rules — return the unsubscribe, and
subscribe on mount rather than lazily on first navigation:

```ts
const off = bridge.onHostNavigate((path) => myRouter.push(path));
// …call off() on teardown.
```

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
| iframe → parent  | `TOAST`                         | `{ message, variant?, action?: { label, path } }`                  |
| iframe → parent  | `NAVIGATE`                      | `{ href }`                                                         |
| iframe → parent  | `FLASHMANDU_BRIDGE:SET_PAGE`    | `{ title?, crumbs[], actions[], dirty }`                           |
| parent → iframe  | `FLASHMANDU_BRIDGE:ACTION`      | `{ id }`                                                           |
| iframe → parent  | `FLASHMANDU_BRIDGE:LOADING`     | `{ active }`                                                       |
| iframe → parent  | `FLASHMANDU_BRIDGE:SET_SIDEBAR_LINKS` | `{ links: [{ label, path, icon? }] }`                        |
| parent → iframe  | `FLASHMANDU_BRIDGE:HOST_NAVIGATE` | `{ id, path }`                                                   |
| iframe → parent  | `FLASHMANDU_BRIDGE:HOST_NAVIGATE_ACK` | `{ id, path }`                                               |
| iframe → parent  | `FLASHMANDU_BRIDGE:SET_CAPABILITIES` | `{ capabilities: { hostNavigate, action } }`                  |
| iframe → parent  | `FLASHMANDU_BRIDGE:TOKEN_REFRESH` | `{ id }`                                                         |
| parent → iframe  | `FLASHMANDU_BRIDGE:TOKEN`       | `{ id?, token, expiresAt?, error? }`                               |
| iframe → parent  | `FLASHMANDU_BRIDGE:MODAL_OPEN`  | `{ id, mode: 'message'\|'route', title?, body?, confirmLabel?, cancelLabel?, path? }` |
| iframe → parent  | `FLASHMANDU_BRIDGE:MODAL_CLOSE` | `{ id? }`                                                          |
| parent → iframe  | `FLASHMANDU_BRIDGE:MODAL_RESULT`| `{ id?, confirmed, error? }`                                       |
| iframe → parent  | `FLASHMANDU_BRIDGE:PICKER_OPEN` | `{ id, kind: 'item'\|'media', multiple?, query? }`                 |
| parent → iframe  | `FLASHMANDU_BRIDGE:PICKER_RESULT` | `{ id?, cancelled, selections[], error? }`                       |

`CONTEXT` additionally carries `capabilities` (what the HOST can do:
`directApi`, `modal`, `picker`, `tokenRefresh`, `loading`), an optional
`directApiEndpoint`, and an optional opaque `channel` the SDK echoes on every
outbound envelope.

### `SET_PAGE` — the page chrome, in one message

```jsonc
{
  "type": "FLASHMANDU_BRIDGE:SET_PAGE",
  "payload": {
    "title": "Kathmandu",                                  // optional, <=120 chars AFTER trim
    "crumbs": [ { "label": "Maps", "path": "/maps" },      // <=5, last = current page
                { "label": "Kathmandu" } ],
    "actions": [ { "id": "save", "label": "Save",          // <=4
                   "variant": "primary", "icon": "check",
                   "disabled": false, "loading": false } ],
    "dirty": false                                          // REQUIRED, real boolean
  }
}
```

The host enforces every cap with a **whole-payload rejection** — unlike
`SET_SIDEBAR_LINKS`, a bad entry does not get individually dropped, because a
partial breadcrumb lies about where the merchant is. So the SDK validates the
same rules client-side and **throws `BridgeValidationError`** rather than
posting something that will silently vanish:

| Field | Rule |
| --- | --- |
| `dirty` | Required. Must be a real `boolean`. |
| `crumbs` | At most 5. `label` non-empty, ≤48 chars. |
| `crumbs[].path` | Must match `/^\/[A-Za-z0-9_\-/]*$/` and be ≤200 chars. No query, fragment, dot segments or percent-encoding. |
| `actions` | At most 4. |
| `actions[].id` | `/^[A-Za-z0-9_-]{1,32}$/`, **unique within the payload**. |
| `actions[].label` | Non-empty, ≤48 chars. |
| `actions[].variant` | `primary` \| `ghost` \| `danger`. |
| `actions[].disabled` / `.loading` | Boolean when present. |
| `actions[].icon` | Allow-list: `check`, `plus`, `trash`, `arrow-path`, `pencil-square`, `arrow-down-tray`. An **unknown icon is not an error** — the host renders no icon. The SDK passes it through and warns once. |

**Crumb clicks are not a new message.** The host renders crumbs as anchors and
routes clicks through the existing `HOST_NAVIGATE` + ack path. An app whose
crumbs carry a `path` must therefore register `onHostNavigate` (announcing
`SET_CAPABILITIES { hostNavigate: true }`) or every crumb click is a full page
reload — exactly the same rule as sidebar links.

### `ACTION` — a bar button was clicked

```jsonc
{ "type": "FLASHMANDU_BRIDGE:ACTION", "payload": { "id": "save" } }
```

Handle it and re-send `SET_PAGE` with `loading: true` on that action while the
work runs:

```ts
bridge.onAction(async (id) => {
  if (id !== 'save') return;
  bridge.setPage({ ...chrome, actions: [{ ...saveAction, loading: true }] });
  await save();
  bridge.setPage({ ...chrome, dirty: false });
});
```

`onAction` is what announces `SET_CAPABILITIES { action: true }`; the host uses
it to decide whether a bar button may be rendered at all, since a button nobody
is listening to is a dead button.

### `LOADING` — the progress bar

```jsonc
{ "type": "FLASHMANDU_BRIDGE:LOADING", "payload": { "active": true } }
```

The host throttles to one state flip per 100ms — a flip inside the window is
**deferred, not dropped** (last writer wins) — and auto-clears after 15s as a
stuck-app guard. Always pair it in a `finally`.

### Token refresh

`getSessionToken()` returns the cached embed token while more than 60s of
validity remains, and otherwise posts `TOKEN_REFRESH` and awaits the host's
`TOKEN`. **Concurrent callers share one in-flight promise** — three widgets
mounting at once produce one refresh, not three.

`TOKEN.expiresAt` is **ISO-8601**, passed through verbatim from the host's
refresh endpoint (a numeric ms epoch is also accepted). `TOKEN { id, error }`
is a **terminal** failure — `refresh_failed_401|403|404|419|429`,
`refresh_malformed`, `network_error`, `unknown_app` — and the SDK rejects
rather than retrying.

Like every non-`READY` message, `TOKEN_REFRESH` carries the envelope `channel`;
the host drops a mismatched one, and a dropped refresh presents as a hang
rather than an error.

### Two API surfaces, two protocols

They are **not** interchangeable, which is why they are separate methods:

| | `bridge.request()` | `bridge.graphql()` |
| --- | --- | --- |
| Transport | postMessage → host `/api/apps/proxy` | direct `fetch` to `/api/apps/graphql` |
| Protocol | REST over a five-path allow-list | real GraphQL (`{ query, variables, operationName }`) |
| Auth | merchant session, host-side | `Authorization: Bearer <session token>`, `credentials: 'omit'` |
| Availability | always | requires `CONTEXT.capabilities.directApi` |

The direct endpoint is Lighthouse's `GraphQLController` mounted directly, not a
twin of the proxy — posting a `{method, path, body}` envelope at it fails. And
because the app's origin must be on the endpoint's CORS allow-list, `graphql()`
**rejects with a clear error** when the host did not announce `directApi`
(which is what happens when it cannot resolve an app id) rather than emitting a
request that surfaces as an opaque network error. Use `request()` there.

The app's long-lived `api_token` is **rejected** by the direct endpoint whenever
an `Origin` header is present — only `getSessionToken()` output works from a
browser. `getSessionToken()` is called for you.

### Branch on HTTP status BEFORE parsing a GraphQL response

Field-level failures and transport failures do not share a body shape:

| Status | Body | Meaning |
| --- | --- | --- |
| `200` | `{ data }` or `{ errors: [{ extensions: { code: 'SCOPE_DENIED', scope } }] }` | **A scope denial is a 200.** Read `body.errors`. |
| `403` | `{ error: 'origin_not_allowed' }` | Origin registered by no installed app. Terminal. |
| `401` | `{ error: 'invalid_token' }` | Bad HMAC / expired / disabled install — or an `api_token` sent with an `Origin`. Terminal. |
| `401` | `{ error: 'origin_mismatch' }` | Valid token, wrong app's origin. Terminal. |
| `429` | throttle body | `Retry-After` + `X-RateLimit-*`. Retried for reads. |

`result.body` is always the **whole** envelope, never just `data`: a partial
success carries both halves.

### Retry and rate limits

- `request()` — idempotent **GET**s auto-retry on `429`/`503` with jittered
  exponential backoff (full jitter), max 3 attempts, honouring `Retry-After`.
  **POSTs are never auto-retried.**
- `graphql()` — every call is an HTTP POST, so the **operation** decides, not
  the method: a document containing no `mutation` and no `subscription` is
  retried like a GET; anything else never is. The check scans the whole
  document, because a multi-operation document ships its mutation text even
  when `operationName` names the query.
- Either can be overridden per call with `retry: true | false` — use `true`
  only when the write carries its own idempotency key.
- `401`/`403` are terminal and never retried.

Every result carries `status`, `body`, `retryAfter`, `remaining`, `limit`,
`reset`, `attempts` and `transport`. `limit`/`reset` are direct-only (from
`X-RateLimit-Limit`/`-Reset`, exposed via CORS); the proxy does not forward
them and reports `null`.

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
they keep working unchanged rather than snapping back. For React and Next apps
the announcement is made by mounting `<UrlSync />`; see
[Framework adapters](#framework-adapters).

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

…and once more, restating the **current** state, when `CONTEXT` arrives.

It is deliberately **not** sent at construction — a React app subscribes in an
effect after mount, so a boot-time announcement would always claim the wrong
thing — and not on the second or subsequent subscribe. A missing announcement
and `{ hostNavigate: false }` mean the same thing to the host.

**The repeat on CONTEXT exists so a late-wiring host cannot miss the
announcement.** The message is fire-and-forget: if the app subscribes before the
host has attached its own listener, the only announcement it was ever going to
get lands on the floor, and the host silently falls back to full-page navigation
for the rest of the session. CONTEXT is the one moment the host is provably
listening, so the SDK restates whatever the state is then — `true` if a listener
has attached, `false` if none has yet, with the first-subscribe transition
following a moment later.

**Therefore the host must treat `SET_CAPABILITIES` as idempotent state, not as
an event to count.** The same flag will legitimately arrive twice (subscribe,
then CONTEXT). Overwrite what you hold; never toggle, tally, or assume a
duplicate means something changed.

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
  readonly hostCapabilities: HostCapabilities;
  readonly channel: BridgeChannel;          // low-level post/subscribe seam

  ready(): Promise<AppContext>;

  // Chrome
  setPage(page: { title?: string; crumbs: PageCrumb[]; actions: PageAction[]; dirty: boolean }): void;
  onAction(listener: (id: string) => void): () => void;
  loading(active: boolean): void;

  // Shell
  toast(message: string, variantOrOptions?: ToastVariant | { variant?: ToastVariant; action?: { label: string; path: string } }): void;
  navigate(href: string): void;
  setSidebarLinks(links: Array<{ label: string; path: string; icon?: string }>): void;
  onHostNavigate(listener: (path: string) => void): () => void;

  // Data
  getSessionToken(): Promise<string>;       // single-flight refresh

  // REST, over the postMessage proxy. Always available.
  request(input: {
    method: 'GET' | 'POST';
    path: string;
    body?: Record<string, unknown> | null;
    retry?: boolean;
  }): Promise<ResponseResult>;

  // GraphQL, direct. Requires CONTEXT.capabilities.directApi.
  graphql(
    query: string,
    variables?: Record<string, unknown>,
    options?: { operationName?: string; retry?: boolean },
  ): Promise<ResponseResult>;

  // where ResponseResult = {
  //   status: number; body: unknown;         // body = the WHOLE GraphQL envelope
  //   retryAfter: number | null; remaining: number | null;
  //   limit: number | null; reset: number | null;   // direct transport only
  //   attempts: number; transport: 'direct' | 'proxy';
  // }

  // External accounts
  connectExternal(url: string, options?: {
    timeoutMs?: number;
    allowedOrigins?: readonly string[];
    features?: string;
  }): Promise<{ connected: boolean; detail?: unknown }>;

  on(event: 'context'|'ready'|'destroy', listener: (payload: unknown) => void): () => void;
  destroy(): void;

  modal?: ModalApi;    // installed by attachModal()
  picker?: PickerApi;  // installed by attachModal()
}
```

### `@flashmandu/app-bridge/server` — Media Library writes (0.6.4, `visibility` 0.6.5)

Apps store their files in the merchant's Media Library (same profile, same
quota, one library across every app), never in their own bucket. Needs the
`write:media` scope in the app's manifest.

```ts
import { hostClientFor, loadConfig, MediaQuotaError, MediaScopeError } from '@flashmandu/app-bridge/server';

const cfg = loadConfig();
// Per request: the browser's direct token for THIS store, profile-checked (0.6.6).
const client = await hostClientFor(req, cfg);

const item = await client.media.upload(buffer, { filename: 'pano.jpg', collection: 'tours', alt: 'Lobby', visibility: 'public' });
// → { id, url, filename, mimeType, size, collection }  (url is null for a private item;
//   visibility omitted → the host default, private)
await client.media.delete(item.id); // only items this app added
```

| HTTP | Error class           | `code`           | Meaning                                         |
| ---- | --------------------- | ---------------- | ----------------------------------------------- |
| 403  | `MediaScopeError`     | `scope_denied`   | `write:media` not granted (merchant must approve) |
| 413  | `MediaTooLargeError`  | `too_large`      | over the platform's per-file limit (message names it) |
| 422  | `MediaInvalidError`   | `invalid`        | the host refused the file or a field            |
| 507  | `MediaQuotaError`     | `quota_exceeded` | the profile's media storage is full             |

All extend `FlashmanduMediaError` (`code`, `status`, `serverCode`); any other
status is `code: 'http'`, a failed fetch is `code: 'network'`. The host's
`message` is for logs; show merchants your own copy keyed on `code` /
`serverCode`.

### Acting for the store: `directFetch` + `hostClientFor` (0.6.6)

A pod's `FLASHMANDU_API_TOKEN` is minted for ONE install and is short-lived,
so it cannot act for each store. The per-install token is the host's DIRECT
token, which only the iframe can mint (TOKEN_REFRESH). So:

```ts
// Browser — every call that makes your server talk to the host:
import { directFetch, directHeaders } from '@flashmandu/app-bridge/react';
await directFetch(`/api/photos?profileId=${id}`, { method: 'POST', body });
for (const [k, v] of Object.entries(await directHeaders())) xhr.setRequestHeader(k, v); // XHR uploads

// Server route:
import { HostClientError, hostClientErrorHeaders, hostClientFor, loadConfig } from '@flashmandu/app-bridge/server';
try {
  const host = await hostClientFor(req, loadConfig()); // me().profile_id === session profile, else throws
  await host.media.upload(file, { filename, visibility: 'public' });
} catch (err) {
  if (err instanceof HostClientError) {
    return Response.json({ error: 'Your copy here' }, { status: err.status, headers: hostClientErrorHeaders(err) });
  }
  throw err;
}
```

- Header `X-Flashmandu-Direct-Token` carries the token; the server uses it as
  the Bearer for `/api/apps/me`, `/api/apps/media` and `/api/apps/graphql`.
- `hostClientFor` fails CLOSED (`HostClientError.code`): `direct_token_missing`
  401, `direct_token_rejected` 401, `no_session` 401, `api_base_missing` 503,
  `host_unreachable` 502, `profile_mismatch` 403. It never falls back to the
  pod token.
- On `direct_token_rejected` answer with `hostClientErrorHeaders(err)`
  (`X-Flashmandu-Direct-Token-Rejected: 1`); `directFetch` re-mints once and
  retries.
- `loadConfig().apiBase` is `FLASHMANDU_API_BASE` (set on the pod), else
  `FLASHMANDU_DEV_BOX_BASE_URL`. Use it, not `devBoxBaseUrl`, for host calls.
- No browser behind the call (webhooks, MCP) means no direct token: MCP bodies
  carry a short-lived `api_token`; webhooks keep the pod token and its limits.

### `@flashmandu/app-bridge/modal` — host modal + resource picker

A separate entry so an app that never opens a modal ships none of it.
`attachModal` mutates and returns the same bridge instance:

```ts
import { createAppBridge } from '@flashmandu/app-bridge';
import { attachModal } from '@flashmandu/app-bridge/modal';

const bridge = attachModal(createAppBridge());

const { confirmed } = await bridge.modal.message({
  title: 'Delete map?',        // <=80 chars
  body: 'This cannot be undone.', // <=500 chars
  confirmLabel: 'Delete',      // <=32 chars
  cancelLabel: 'Keep',         // <=32 chars
});

await bridge.modal.route('/maps/9/edit');   // host max-modal at an app route

const { cancelled, selections } = await bridge.picker({
  kind: 'item',      // 'item' | 'media'
  multiple: true,
  query: 'tea',
});
// selections: [{ id, label, thumbnail?, meta? }] — summaries, never full models
```

Caps are validated client-side and throw `BridgeValidationError`, mirroring the
host. One modal and one picker at a time; a second `open` rejects rather than
hanging (the host drops it). A picker refused for a missing scope resolves
`{ cancelled: true, selections: [], error: 'scope' }`.

### `@flashmandu/app-bridge/react` — `usePageChrome`

```tsx
import { usePageChrome, useBridgeLoading } from '@flashmandu/app-bridge/react';

usePageChrome({
  title: 'Kathmandu',
  crumbs: [{ label: 'Maps', path: '/maps' }, { label: 'Kathmandu' }],
  actions: [
    { id: 'save', label: 'Save', variant: 'primary', icon: 'check',
      loading: saving, onSelect: save },
  ],
  dirty: form.isDirty,
});

useBridgeLoading(isFetching);
```

Safe to call with fresh object/array literals every render: the hook diffs
structurally and posts only when something actually changed. `onSelect` is
local — it never goes on the wire; the hook keeps the id → handler map and
routes `ACTION` for you.

### `@flashmandu/app-bridge/testing` — `createMockHost()`

An in-memory implementation of the host half of the protocol. Vitest-first,
fully synchronous, no fake timers required.

```ts
import { createMockHost } from '@flashmandu/app-bridge/testing';

const host = createMockHost();          // installs a fake window; call host.restore() after
const bridge = host.createBridge();     // READY is answered with CONTEXT immediately

bridge.setPage({ crumbs: [{ label: 'Maps' }], actions: [], dirty: false });
expect(host.lastPage()?.crumbs).toEqual([{ label: 'Maps' }]);

bridge.onAction((id) => saved.push(id));
host.clickAction('save');

host.stubSequence('GET', 'orders', [{ status: 429 }, { status: 200, body: [] }]);
const result = await bridge.request({ method: 'GET', path: 'orders' });
expect(result.attempts).toBe(2);
```

Recorders: `pages()`, `lastPage()`, `toasts()`, `loadingStates()`,
`navigations()`, `sidebarLinks()`, `announcements()`, `acks()`, `modalOpens()`,
`pickerOpens()`, `tokenRefreshCount()`, `messagesOf(type)`, `sent`.
Scripting: `clickAction`, `hostNavigate`, `sendContext`, `post`, `stub`,
`stubSequence`, `onApiCall`, `sendToken`, `failToken`, `autoToken`,
`answerModal`, `answerPicker`, `completeExternal`, `closePopup`.

### Connecting external accounts

`connectExternal` opens a popup on the third party, and waits for **the app's
own callback page** (its origin, not the platform's) to post completion back to
the opener. The platform is never involved and never sees a third-party token.

```ts
// In the app: start the flow.
const { connected } = await bridge.connectExternal(
  `https://www.facebook.com/v19.0/dialog/oauth?client_id=…&redirect_uri=${cb}`,
);

// In the app's own /oauth/callback page, after its backend exchanged the code:
window.opener?.postMessage({ connected: true }, window.location.origin);
window.close();
```

A closed popup rejects; so does a blocked popup and a timeout (default 3
minutes). Only `event.source === popup` **and** an origin on the allowlist
(default: the app's own origin) is accepted, so a third-party consent page
cannot fake a completion.

The host-navigation payload types are exported too, for hosts and for apps that
assert on the wire format. Both carry the correlation `id`; the SDK echoes the
one it was given:

```ts
interface HostNavigatePayload    { id: number; path: string }  // parent → iframe
interface HostNavigateAckPayload { id: number; path: string }  // iframe → parent
interface BridgeCapabilities     { hostNavigate: boolean; action: boolean }
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

// iframe → parent. Sent on change (first subscribe, last unsubscribe) and
// restated once on CONTEXT. Idempotent state — the same flag may arrive twice.
{
  "type": "FLASHMANDU_BRIDGE:SET_CAPABILITIES",
  "payload": { "capabilities": { "hostNavigate": true, "action": false } }
}
```

> **Host implementers: expect `true → false → true` from apps in dev.** React
> Strict Mode mounts effects twice, so a development page load produces a
> subscribe, an unsubscribe and a resubscribe — three announcements where
> production sends one. It is not a bug and it is not a teardown you should act
> on beyond updating the flag you hold. Store the last value; never toggle,
> tally, or treat a repeat as a state change.

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
