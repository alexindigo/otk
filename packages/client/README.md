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

`rpc.call(method, params, signal?)` derives its input and result types from
`@otk/protocol`'s declaration-mergeable `RpcMethods` interface. Callers do not
supply result type arguments. `createCurrentClient().call` uses the same
contract with `sessionID` omitted from inputs and injected at invocation time.
Feature-owned module augmentations are shared by server and client consumers.

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
their existing semantics. `createDrafts(factory?)` owns browser-lifetime,
server/session-keyed unsent `Draft` values. `writer(key)` binds updates to one
session and returns invocation-current values even before a framework paints.
Late uploads and sends update only their originating draft; a newer edit is
never cleared by completion of an older submission. Permission/question input
remains owned by its UI feature and protected by navigation confirmation.

`createQuestionForm(request, factory?)` owns the framework-free question steps,
single/multiple option picks and typed own answers. `answers()` derives the wire
reply from that state; choosing a single option retains unselected typed text.
The request-keyed form survives view replacement until `forgetQuestionForm(id)`
after a successful reply. The UI owns focus, collapse and reply progress only.

`replyMetadata(messages)` combines contiguous backend steps for the same reply
using the same grouping owner as `replyMessages(messages)`. The latter supplies
the transcript with stable first-step keys, so expanding a work log or tool is
preserved as later backend steps stream in. Metadata is projected into one final
metadata record, summing only reported tokens/costs and retaining the reply's
start, final clock and interrupted state. No session content is duplicated into
a second store; the projection also combines source parts for whole-reply
copying. No session content is stored outside the currently loaded transcript.

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

## Inbox metadata and tabs

`createInbox(rpc, factory?)` receives connection-local `inbox` frames, including
the snapshot sent on every hello. `openProject`, `openSession` and `act` reset
the server-owned visit clock; opening a session also records its seen timestamp.
Wrap sends, approvals, answers and interrupts in `act(directory, callback)`.
`promote(session)` creates a title-named task with its initial session
atomically. These are UI-independent ports: callers own navigation guards,
action callbacks and failure presentation.

`projectHash` / `projectRoute` provide project-only URLs for empty projects,
separate from session URLs; pass both through the same guarded navigation owner.
`projectName` names a path without embedding server identity. Consumers keep
server IDs alongside shared projections and add machine labels for collisions.
`registerPreferenceCommands` is the framework-free command contribution owner;
its menu/command metadata still derives from the protocol preference registry.

`inboxStatus`, `rollup`, `unread`, `inboxProjects`, `visitTime` and `ageing` are
the shared pure projections for column, rail and badges. Supply the connection's
index entries, its metadata and an explicit current time. Ageing defaults to
2h/8h/24h and accepts the validated `projectAgeing` preference (milliseconds).
Keep each server's inputs separate when merging the resulting project rows.

`createTabs(inbox.promote, factory?)` takes
`update({directory, entries, inbox})` and exposes task, mandatory phantom and
single-preview tabs. `select`, `preview`, `pin` (also the double-click action)
and `send(sessionID, callback)` own tab transitions. Required activity tabs
never disappear when a preview is replaced; an idle/seen selected phantom
remains until selection leaves. Inputs remain owned by their index/metadata
models, and tabs never delete sessions. Concurrent pins share promotion; late
completion cannot steal a newer selection.

An optional third `sources` argument supplies `input()` (owner-current tab
inputs) and `session(sessionID)` (authoritative identity/title/directory
lookup). Tab commands read current inputs before validation, so a deferred
rendering effect cannot reject a newly available tab. Pin/send resolve missing
session metadata without waiting for index replication; concurrent calls share
resolution and promotion, and validate the invocation's project and session
identity before acting. `TabSession` contains only identity, directory and
title: promotion never requires a replicated status/attention row. `update`
remains the view-invalidation port and the input port for consumers that update
synchronously.

Tab state also exposes its selected `sessionID` and an input `revision` for
reactive bindings. `sessionFor(taskID)` resolves the remembered member/helper or
first member; `select(selection, sessionID?)` keeps that session inside its
task. `createTaskActions(rpc, directory)` captures server/project ownership for
task editors before asynchronous interaction. `contextMeter(messages)` uses the
latest reported assistant token footprint (including reasoning and caches) and
sums reported costs for the supplied loaded messages. It supplies no guessed
model context window or percentage; paged consumers label the cost's loaded
scope. `taskBreadcrumbs(task, entries, selected)` preserves explicit membership
order, expands the selected helper path and prevents cycles or duplicate grouped
helpers. Helper URLs retain their owning task; removing membership preserves the
viewed session as an ungrouped tab rather than leaving transcript and task
inconsistent.

`sessionTree(entries, tasks, directory, query?)` projects ordered task groups
followed by “Not in a task”, with parent/child depth. Helpers inherit the
nearest explicitly grouped ancestor; explicit helper membership takes
precedence. Title search retains matching ancestor paths, while missing parents
and malformed cycles cannot hide sessions. Keep each server's entries separate
at the caller.

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
