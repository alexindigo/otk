# @otk/client

Framework-free OTK networking, RPC and state. Production code depends only on
`@otk/protocol`. No Solid runtime is required. LGPL-3.0-only.

## Public API

Import only `@otk/client` (the `mod.ts` entry).

| #  | API                                                             | Purpose                                                                                                              |
| -- | --------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| 1  | `SidecarConnection`, `Rpc`                                      | Auth discovery/login/setup, hello/welcome, heartbeat, reconnect/backoff, subscriptions, cancellable size-bounded RPC |
| 2  | `apiBase`, `normalizeBase`, `request`                           | Prefix-aware HTTP API and cookie-based browser requests                                                              |
| 3  | `createIndex`, `sessionKey`, `projectGroups`, `liveSessionInfo` | Multi-connection index merging with revision-gap detection                                                           |
| 4  | `createSession`, `emptyContent`, `reduce`, `queuedMessages`     | Snapshot/live replay, paging, stream versions, error revisions and visible-output clocks                             |
| 5  | `oldestPermission`, `belongsToSession`, `isAttentionOp`         | Permission/question family ownership and ordering                                                                    |
| 6  | `loadHistory`, `mergeHistory`, `sameHistory`, `sameParts`       | Partial-success cross-connection history with attachment ownership                                                   |
| 7  | `createNavigation`, `route`, `hashFor`                          | Selection and accepted-history traversal with dirty-state callbacks                                                  |
| 8  | `createCurrentClient`                                           | Invocation-time selected connection/RPC context and session-scoped calls                                             |
| 9  | `createState`, `StateFactory`, `StateStore`                     | Synchronous observable state or an injected framework binding                                                        |
| 10 | `createSidecars`, `readSidecars`, `LOCAL_SIDECAR`               | Connection collection and persisted browser sources                                                                  |

Models expose `state` and `subscribe(listener)`; subscriptions return an
unsubscribe function and notify after updates, without an initial notification.
Treat state as read-only outside model methods. A UI binding can supply a
`StateFactory` implementing draft updates and reconciliation. The application's
thin Solid binding retains granular updates at the UI boundary.

Browser connections use cookies. Supply an explicit base URL outside the
browser; `ConnectionOptions.socket` allows a native transport with Origin and
the operator's authenticated cookie. `ConnectionOptions.api` or
`apiBase(baseUrl, assetUrl)` permits explicit asset-prefix resolution. No server
authentication or origin check is bypassed. `createSidecars` additionally
accepts storage and local connection options; non-browser callers usually
compose one `SidecarConnection` directly. Navigation accepts an injected
history/location environment, so its accepted-route model is usable without
browser globals.

Legacy welcome frames retain their supported RPC families; explicit capability
lists are authoritative. Connection metadata remains mounted across reconnects,
while `supports` reports live availability. Session generations, aborted
requests, buffered ops, error and stream revisions and finished clocks retain
their existing semantics. Dirty prompt and permission/question drafts belong to
their UI owners.

## Plain Deno example

[`example.ts`](./example.ts) connects to the main OTK core and prints reduced
content after snapshot or live updates:

```sh
deno run --allow-net packages/client/example.ts http://127.0.0.1:1502 SESSION_ID
```

Use an already configured `none`-auth core for this minimal example.
Authenticated deployments should inject their authenticated native transport.
The standalone consumer in `tests/reuse/client-consumer.ts` imports only
`@otk/client`, sends a prompt through the real application core, and observes
reduced streaming content and a finished assistant clock. Application
integration/e2e tests stay at root; client units live in `tests/`. Run project
checks in the assigned OTK VM.
