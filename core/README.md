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
same composition. Its optional fourth `{ upgrade(store) }` port runs after the
user-data schemas are composed and before feature construction/backend startup.
Main injects the native codec into the application-owned atomic beta.1 reference
upgrade; alternate backends need not supply it. The schema runner stays
SQL-only. Subprocess fixtures launch `main.ts` directly.
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
Authoritative deletion publishes a retained tombstone, preserving task
membership. Explicit index eviction never mutates tasks. Removing a deleted
member is a separate idempotent user-metadata operation.

`session.fork` validates its optional inclusive `through` message and activates
the returned session's project through the same creation bookkeeping port as
`session.create`.

`session.compact` requires a session ID and nonempty provider/model strings,
delegates to `sessionActions.compact` and returns admission only. Native summary
requests and their lifecycle remain in the harness adapter.

`registerRevert` independently selects `session.revert` and `session.restore`
from the respective `revert` and `restore` capabilities. Both validate session
identity; revert additionally validates the boundary message. Neither operation
adds confirmation or overlap detection around the backend's native semantics.

`usage.get` requires a session and turn identity and delegates cancellation to
the optional usage capability. The result includes only that turn's complete
charged call ledger, nullable summary, digest revision and producer content
checkpoint. Source-model baselines, call clocks and existing tool labels contain
no transcript parts or tool inputs/output. Worker detail chunks retain
publication credits and row budgets; bridge leases coalesce by session and turn.
The public UsageLedger supplies keyed live changes without full-session
snapshotting.

`session.messages` validates qualified identity, an optional nonempty cursor of
at most 4096 characters and the exact input shape. It forwards per-call read
cancellation to `HarnessCore.listMessages`; dispatch remains generic. Pages
include coordinated session metadata, newest visible prompt context, content
clocks and bounded catchup. Core forwards the producer's content clock
unchanged. The layered `[messages]` replay policy is injected into the adapter
and supplied as `welcome.messages`; neither libraries nor browsers invent
another defaults table. Connections require this policy explicitly in smaller
compositions too.

The same `[messages]` owner supplies browser scope cooling (`coolms`), temporary
attention leases (`preloadms`) and per-server page admission (`concurrency`).
Partial operator files merge leaf-wise before environment overrides. These
positive safe-integer thresholds do not change the fixed ten-message page size.

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

Index snapshots establish publication boundaries: already-counted queued writes
are delivered before a replacement baseline, never replayed after it. Hello
captures that baseline before admitting the connection to live index delivery. A
reset snapshot also covers synchronous observer writes, preserving their current
metadata without a duplicate counted patch afterward.

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

## Worker-backed digest services

`core/digest/worker.ts` is an application composition root over public store,
harness and native entries. It alone opens `digest.db` and the digest's
read-only native connection. `DigestBridge` owns the lazy module Worker,
run/connection fences, bounded publication credits, ordered revision parts,
coalesced detached catalog/detail reads and an idempotent joined stop. The
bridge has no SQLite connection. Worker crashes retire that lifetime, mark known
identities unready through the injected port and reconcile through one retry
lifetime.

`IndexStore.observeRemoval` publishes explicit eviction from the authoritative
owner before its wire frame is queued. Approval-policy retirement uses that port
and ordinary metadata observations; it does not decode index operations from
transport. Browser consumers likewise use the shared keyed-index reduction.

Cancelling the last read caller sends `{t:'cancel',request}` under its `run`.
`DigestRequests` aborts that worker-owned read and releases the scheduler slot;
unknown/finished cancellation is ignored. Releasing one of several coalesced
callers does not cancel the other callers. Clean shutdown joins requests and the
scheduler, closes native/derived connections and acknowledges `stopped`; forced
termination is reserved for failure.

The shipped composition selects this worker and passes its optional port to the
native adapter. Catalog parts seed metadata before digest deltas; the shared
index preserves newer live status and attention. An accepted deletion event
crosses the generation-fenced `DigestPort.deleted` port and commits
independently of health/inventory. Current OTK intents classify matching
deletions; stale generations and duplicate notifications do not change the
retained outcome.

The bridge coalesces accepted deletion identities and admits one bounded batch
at a time, retaining them across worker retries. It restores current logical
deletion intents before replaying those facts, then resumes provider catalog
reconciliation. Provider health is not a prerequisite for committing accepted
deletions or reading their cached tombstones.

`digests.scope` is feature-owned and replaces one socket's visible priority
hint. Generic `RequestLifetime` owns socket leases. A separate per-call
`ctx.execution.signal` reaches usage detail: `rpc.cancel` releases only that
connection's matching in-flight read, with unknown/completed IDs ignored. The
registry's injected observation callback uses unique dispatch tokens for
interactive pressure. Mutation handlers do not consume read cancellation.

Inbox observers use hydrated project policy and seen/finish projections, updated
by committed store changes. A busy→idle edge records its returned committed
clock without a follow-up SELECT; digest observations perform no baseline SQL
reads. Tombstones retire approval policy without creating synthetic finish
edges.

The layered `[digest]` policy is documented in `defaults/otk.toml`; positive
integer bounds, the 200-row native ceiling and CPU duty bounds validate with
node/environment diagnostics. The compile recipe embeds the literal worker and
both migration trees and grants `systemMemoryInfo`. An independent compiled
consumer runs off-source with empty runtime caches and observes native totals
change and survive restart. The shipped binary is separately exercised
off-source with empty caches, SSE summary changes, retained tombstones and a
restart.

Digest admission uses the runtime's available-without-swapping memory estimate,
including reclaimable cache, against the injected reserve. Catalog invalidations
commit as one batch before jobs are admitted. Optional injected diagnostics
observe serving sections and worker pressure/native read counts; they introduce
no operator flag or public debug RPC.
