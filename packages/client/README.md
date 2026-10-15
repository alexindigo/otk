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

## Commands

`new CommandHub(context, keys)` creates an empty, framework-free registry. A
feature registers `{ id, title, category, slash?, enabled?, run }` through
`register`; the returned release function is identity-bound and idempotent.
`unregister(id)` removes an explicit registration. `run(id, args)` snapshots
consumer-supplied context at invocation, checks availability and returns the
handler's value or error. Unknown and disabled IDs reject. `list(context?)`
reports title/category, enabled state and injected key labels; `resolveSlash`
resolves declared aliases. `subscribe` observes registration changes.
`metadata(id)` returns frozen, data-only owner metadata even for hidden
commands; `list` uses the same read-only projection but keeps hidden commands
undiscoverable. Neither metadata surface exposes execution handlers or
availability callbacks; invocation and its availability check remain owned by
`run`.

Features own registration and execution; the hub contains no shipped feature
list, browser globals or UI runtime. Inputs and callbacks stay with the
consumer. The plain Deno consumer in `tests/reuse/commands_test.ts` uses this
public entry to update independent selected counters, resolve aliases and
release ownership.

## Notifications

`NotificationHub(policy, run, error)` is an empty framework-free registry.
Owners register a `NotificationChannel` through `registerChannel`, returning an
identity-bound release. A data-only `Note` has an ID, kind, optional
sidecar/root reference and command-ID actions. `publish` replaces the ID;
`replace(previous,
input)` enriches only the current identity without replaying
sound. Delivery ports scope `current`, `dismiss`, `invoke` and `unavailable` to
the exact note and channel registration. `currentNote` and `invokeDefault`
retain a live logical note's default action across focus-triggered presentation
retraction, including a native click queued after focus. Viewing, replacement
and channel release invalidate that port. Stale timers, clicks and async lookups
cannot consume a newer note. Invocation never assumes that a resolved command
actually selected the session. Consumers call `viewed` after real guarded
selection and focus.

`NotificationTriggers` observes accepted index frames, using the first snapshot
after each connection's `reset` as a silent baseline. Root attention roll-ups
already include children; roots produce one keyed done/input/error note per
sidecar. Error observations remain genuine independent backend observations.
`notificationPolicy` is separately selected, injecting host preferences, focus,
visibility and viewed root. General messages use the in-page surface. The hub
itself knows no concrete channel, application, backend, browser or UI framework.
The standalone Deno notification consumer routes external job acceptance through
the public command hub and proves stale-note isolation.
