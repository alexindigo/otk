# OTK application core

OTK is the main application. Its core owns config/authentication, reflective
HTTP routing, WebSocket transport, the live session index and feature-owned RPC
adapters. Reusable kit libraries supply protocol, content, backend contracts and
persistence. Opencode is one backend; core services accept any `Harness`.

## Application composition

Root `main.ts` selects the backend/content buffers, resolves layered config and
web assets, and owns process signals. Root `application.ts` supplies the shipped
store migrations and feature registrations through
`startApplication(cfg, backend, staticRoot)`. External-backend fixtures use that
same composition; subprocess fixtures launch `main.ts` directly.
`startCore({ cfg, backend, store, prefs, rpc, staticRoot })` starts that backend
and the application's reflective Pathfinder HTTP/WS service. Its `CoreServer`
exposes `server`, `backend`, `index`, `connections` and `stop()`. Stop closes
connections, stops the backend, shuts down HTTP and closes the store; the
application owns this lifetime.

Acquisition rolls back on auth, backend or listener failure. Feature sources,
index/prefs/source subscriptions, backend, HTTP listener and store are each
released even when another cleanup fails; startup and cleanup causes are
retained. Concurrent stop calls join one idempotent teardown. Connections
release timers and subscriptions immediately and cannot rearm them from a late
RPC completion.

`RpcRegistry(backend, store)` dispatches registered methods and gives handlers
`RpcContext` (`harness`, `store`, authoritative `sessionDirectory(id)`).
Features own `params` validation and `handler`; `register(method, definition)`
rejects duplicate names. Invalid params and handler errors propagate to the WS
request owner. Unknown/unregistered methods return the existing `method` error.
Method names and handler results derive from the open protocol `RpcMethods`
interface. Validators still accept untrusted wire objects and may return their
own parsed representation; that representation types the handler's input.

`registerSessions`, `registerPrefs` and `registerFrecency` provide core and
store features; prefs/frecency take their store as a third argument. Optional
`registerPrompt`, `registerShell`, `registerCommands`, `registerHistory`,
`registerFiles`, `registerAgents`, `registerModels`, `registerUsage`,
`registerResources`, `registerPermissions`, `registerQuestions` and
`registerRevert` register only when their backend capability exists. Registry
machinery never composes those features; `application.ts` does. `prefsOptions`
and `frecencyOptions` retain OTK preference/path validation. `agents.list` keeps
mention-list behavior by default and accepts optional boolean `primary` for the
essential agent-cycle command. The neutral agents capability receives that
optional selection; the native backend excludes hidden agents and selects
primary/all agents for cycling, or subagent/all agents for mentions.

`models.list` validates a session ID and delegates to the optional models
capability. Its catalog and agent metadata are neutral protocol shapes; native
provider/config requests and credential filtering belong to the adapter.

`registerSessionActions` contributes `session.rename` only when the optional
`sessionActions` capability is present. It validates the session ID and a
trimmed 1–200-character title, then forwards to that capability. Application
composition selects this feature alongside the existing session registrations.
It also contributes validated `session.delete` through `sessionActions.remove`.
InboxFeature removes explicit deleted IDs from task membership on index `remove`
operations, including IDs outside the current window. Snapshot/window eviction
never removes membership; task-store broadcasts publish each committed removal.

`session.fork` validates its optional inclusive `through` message and activates
the returned session's project through the same creation bookkeeping port as
`session.create`.

`usage.get` delegates to the optional usage capability. Its whole-session and
user-turn summaries include source-model totals and keyed message-usage
baselines, call clocks and small existing tool labels, never transcript parts or
tool inputs/output. The public UsageLedger owns aggregation and the complete
turn range, and idempotent live replacement; transcript pagination never limits
charged usage totals.

The existing `welcome.sidecar.harness` wire shape gains a `capabilities` array
advertising present backend capabilities. Consumers gate optional features on
it. Core sessions, prefs and frecency need no optional backend capabilities.
Existing `OTK_HARNESS_*`, cookie, origin and protocol names remain compatible.
Older welcome frames without the new field retain their legacy RPC families;
explicit empty/subset advertisements remain authoritative. Both browser
consumers use the protocol's shared normalization. Feature metadata stays cached
while transport reconnects so dirty permission/question owners remain mounted.

`loadServiceConfig` layers explicit defaults/overlay/auth-state/environment
inputs; its state path may still contain the empty default sentinel.
`config(sources)` is the service-ready boundary: it resolves the state directory
once from those supplied inputs, loads generated auth state there and publishes
that same path as `cfg.state.path`. Authentication and every store composition
consume this value without consulting the process environment again. Root
bootstrap owns memoization and default paths. `AuthState`, `LocalAuth`, password
helpers and `allowedOrigin` retain cookie/origin/JWT/TOTP behavior. First-run
setup writes and syncs a private same-directory staging file, then publishes its
complete contents through a no-overwrite hard link. Write, file-sync and
publication failures leave setup retryable; concurrent owners cannot replace the
winning identity. Publication is the commit point. Directory-sync or staging
cleanup failures after it are diagnosed without reporting committed setup as
unconfigured. Restart reads the same committed `auth.toml` through config.
`Connections`, `IndexStore`, `serve`, `staticResponse`, `promptParts`, `object`
and `text` are shared core implementation helpers. `IndexStore` extends the
harness-neutral `SessionIndex` owner and adds wire revisions/batching. Core
passes that same owner in the backend sink, so directory, family, attention and
transport reads share one authoritative metadata index.

## Example

[`example.ts`](./example.ts) illustrates an alternate sessions/prompt
application composition accepting a backend, config and asset directory:

```ts
import type { Harness } from "@otk/harness";
import { OtkDb, Prefs, prefsMigrations } from "@otk/store";
import {
  prefsOptions,
  registerPrefs,
  registerPrompt,
  registerSessions,
  RpcRegistry,
  type ServiceConfig,
  startCore,
} from "./mod.ts";

async function run(backend: Harness, cfg: ServiceConfig, staticRoot: string) {
  const store = new OtkDb(cfg.state.path, [prefsMigrations]);
  const prefs = new Prefs(store, prefsOptions);
  const rpc = new RpcRegistry(backend, store);
  registerSessions(rpc, backend);
  registerPrompt(rpc, backend);
  registerPrefs(rpc, backend, prefs);
  rpc.register("example.directory", {
    params: () => "example-session",
    handler: (ctx, id) => ctx.sessionDirectory(id),
  });
  return await startCore({ cfg, backend, store, prefs, rpc, staticRoot });
}
```

The example's extra method declares its contract beside the feature:

```ts
declare module "@otk/protocol" {
  interface RpcMethods {
    "example.directory": { params: Record<string, never>; result: string };
  }
}
```

The application chooses all shipped registrations in root `application.ts`.
Adding a feature needs its registration in caller composition, never a central
dispatch edit. HTTP handlers remain discovered from `http/routes/`, including
API auth middleware; there is no handwritten route table.

`core/mod.ts` is a local application convenience entry, not a workspace package.

`InboxFeature` composes project/task/seen/finish/template stores and owns inbox
RPC validation and metadata frames. `IndexStore.observe` supplies synchronous,
detached before/after entries, so a busy-to-idle edge cannot disappear inside a
wire batch. Initial idle snapshots do not invent finish times. Activity clears
persisted inactive marks for affected users without tracking index-only
directories. Template discovery scans on startup and template edits, fencing
retired/closed results; snapshots carry these directory names independently of
tracked projects. Creation and successful action bookkeeping activate projects
through the existing store owner; viewing visits do not. Add project creates its
initial session. `Connections` consumes generic `FrameSource`s with welcome
snapshots and lifetime-bound listeners; it imports no inbox feature. The shipped
single-user server resolves its current configured auth username (or `local`) at
use time as the project/seen storage key, including after first-run setup. No
authentication contract changes are needed. Inbox RPCs are core-owned, not
optional backend capabilities. Templates expand one `{project}` path segment on
this server, never a recursive wildcard search. The smaller
[`example.ts`](./example.ts) is retained as an alternate composition; its
core-only routes and absence of optional RPCs are covered by the service test.

`tasks.addSession` validates the session's authoritative project, then applies
the single-member intent in the task store's transaction; `tasks.removeSession`
removes only that task/member pair, even if the backend no longer has the
session. Both operations are idempotent and broadcast committed metadata through
the same inbox source. `tasks.sessions` remains explicit full membership
replacement for callers intentionally replacing or reordering the complete list.

`registerLayout(rpc, prefs)` contributes `layout.patch` for shell field intents.
It synchronously merges each patch into the latest persisted `shellLayout`, then
uses the existing complete-value validator, save and preference broadcast. Rapid
controls and separate browser connections therefore preserve independent fields;
UI preference state still follows authoritative broadcasts without optimistic
copies. Invalid patches cannot partially persist. Explicit `prefs.set`
replacement remains available for complete preference values.

`PermissionFeature` is selected by application composition only for a backend
with permissions. Its independent store holds explicit session auto-approve
policies and a durable reply journal. It observes the same authoritative index
as the backend and lists pending families on attention and enabling, including
bootstrap/reconnect; browser subscriptions are irrelevant. Cycle-safe ancestry
and current policy are checked immediately before each automatic Allow once.
Manual and automatic replies share request serialization and journal intent,
confirmation and failure; shutdown leaves unacknowledged intent unconfirmed. The
existing permissions registration accepts this injected reply owner.

The reply journal captures family membership at dispatch; historical activity
does not depend on the current live index window. Pending helpers also schedule
their enabled ancestor when that ancestor's own index entry is absent. The
feature contributes `permission.auto` and paged `permission.activity`, and uses
the existing FrameSource lifetime for authoritative `approvals` snapshots. It is
not a global preference or a native permanent grant. Its metadata stream
contains explicit session IDs/revision, not transcripts; activity is read on
demand in pages of100 for the selected family. Turning a policy off and reading
its journal remain available while the native backend is offline; enabling
validates the session through the existing backend lookup. Enabling validates
root-only eligibility on authoritative backend metadata; helpers inherit and
cannot acquire an explicit policy by direct RPC. Explicit index removals delete
stored policy, including IDs outside the current window; snapshot window
eviction alone does not. Failed automatic requests are memoized by normalized
request fingerprint until it changes or a successful index snapshot starts
another connection generation. Unrelated index updates cannot repeat a failed
attempt or journal row. Policy revisions and affected-family activity
invalidations are separate feature-owned frames.

Core tests live in `tests/unit/core/`; application integration/e2e tests stay at
root. They cover config, auth/index, RPC validation/capability absence and
actual HTTP/WS/browser behavior. Library units stay in their packages. Core is
not a separate JSR package: public-entry/dry-run checks apply only to reusable
libraries. Run project workloads inside the assigned OTK VM.
`tests/integration/composition_test.ts` additionally observes the shipped
composition through the public framework-free client: external backend index and
transcript, capability-selected RPC forwarding, preference broadcast and
persisted prefs/frecency after an application restart. The separate minimal-core
service test preserves alternate selected-registration HTTP/static/SPA/origin
coverage.
