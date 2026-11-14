# OTK application core

## Durable project identity

`InboxFeature` composes one `ProjectIdentity`, backed by the independently
migrated `Checkouts` store in `otk.db`. Adapters supply native identity and
inventory facts; ProjectSummaries consumes the owner's checkout projection.
Native source/repository identity owns membership, while canonical paths remain
mutable locators. Recorded checkout roots and learned history survive pruning,
native restarts and canonical relocation. `present | removed | unknown` is an
independent availability fact, never an automatic inactivity policy.

Summary `memberships` retain exact scopes and every native owner on shared
paths. Clients consume these exact mappings and never perform prefix inference.
Insufficient root evidence remains unresolved instead of merging a removed
nested checkout into the canonical root. Grouped scalar reads remain bounded;
identity does not require a session catalog or transcript scan.

## Session hierarchy

`IndexStore.hierarchy` is the single `SessionHierarchy` owner. It retains only
demanded structural identities, not digests or transcripts. Native family
identity survives checkout moves; ancestry is explicitly complete, unresolved or
cyclic. `ProjectIdentity` supplies checkout-local anchors. Nearest explicit task
ownership is checkout-local unless the host-sidecar `tasksFollowParent`
preference is on. The view carries that setting to every server, independently
of execution paths.

Index and bounded list pages publish the same neutral hierarchy nodes. Parent,
task and topology changes reproject retained entries and demanded lists. Tabs,
Sessions, family actions, approval coverage and project rollups use this
contract; notification identity stays per session. Every ungrouped mandatory
child keeps its own phantom and lamp; viewing a child selects its checkout-local
display root or owning task. Foreign parents remain breadcrumb links. The open
session's name is independent of the root/task label and lamp. Child pagination
is parent-scoped, not checkout-scoped, on V1 and V2.

## Evidence-based session supervision

`InboxFeature` composes one `SessionSupervision` beside the index. Adapters
supply fresh work and pending-input identities plus monotone proven terminal
tokens. Neither legacy status transitions nor digest/population readiness create
evidence. The per-user inbox projection carries
`needsYou | working | finishedUnseen | none`. `none` renders grey with "No known
activity"; stale inventories no longer count. Rollups include children, but each
session's lamp describes only that session.

`sessions.seen` acknowledges the captured displayed terminal, never server time.
Seen/finish feature v2 retains terminal tokens separately from legacy
observation clocks. Old clocks survive but cannot acknowledge proven history.
Native viewed state is neither read nor written. Completion requires a proven
terminal.

## View-scoped publication (protocol 20)

A selected socket view parks optional work until the first message page settles.
The client acknowledges accepted state after rendering; failures and
cancellation settle through the page request owner. Selection replacement and
disconnect fence late acknowledgements. Empty selections, essential/attention
reads and effects remain independent of this barrier. View presence begins at
hello, not TCP open.

Connections own a generation-fenced socket view (project, selection, crumbs and
visible Sessions keys). IndexView publishes local revisions, incremental scope
acquisition and explicit eviction, separately from authoritative deletion. Only
selection retains turn summaries; other leased entries carry scalar digest
summaries. Feature-owned connection projections scope inbox tasks/marks and
approval metadata. All projects retain their server-owned row/lamp summaries.
`sessions.list` supplies bounded project/query pages (20 by default, at most
200), independently of catalog completeness. Cached rows publish through a
request-correlated `load.chunk`; the ordinary result completes only that page's
boundary under its source generation. Visible rows acquire entries through the
same view, without preloading transcripts. Hierarchy and task grouping come from
the shared server projection. Remembered selection uses authoritative keyed
identity validation through `NavigationDefault`. Project clicks and
cold/reloaded project routes share this read: supervision attention in the
existing priority order, exact remembered identity (including children), then
the newest top-level session across checkout scopes. Attention borrows
SessionHierarchy membership; the fallback reads at most one native root per
exact scope and never scans a transcript or acquires the project population.
Host-sidecar layout memory is passed as a candidate, never accepted by a
client-side shortcut. Recall resolves the selected identity before reading its
project, never discovered sources.

Index publication has one outstanding bounded chunk per socket. `index.applied`
returns credit only after client reduction. Updates coalesce by key while credit
is held. A replacement epoch replays unacknowledged keys from current authority;
its `from` revision rebases local sequencing without a full resnapshot.

RequestAttention contributes a feature-owned lease for pending manual
permissions and questions on every connected server. Outside the ordinary view
it publishes only routing identities, titles, project/parent links and pending
counts, with no digest, usage or activity history. Existing permission/question
reads deliver the pending request through their request-owned lifetime.
Settlement evicts this metadata unless another view still owns it; automatic
permissions do not acquire the user-attention lease.

`FormsFeature` registers typed `form.list/reply/cancel` operations and publishes
volatile `forms.pending` attention state. Answer values remain typed; completion
receipts contain no answer or attachment bodies. Location-owned forms contribute
scalar `ProjectSummary.locationForms` attention without inventing sessions or
changing session counts. The shared `SurfaceRegistry` also supplies global
surfaces for requests that have no selected session. Session forms use the
existing takeover owner; both render the same retained form state, validation
and exact review payload. Hidden/conditional drafts remain private when
inactive, and opening an external link never substitutes for explicit
acknowledgement.

## Beta.2 startup and upgrade

The release advertises `0.1.0-beta.2` with protocol 17. Before backend startup,
feature migrations compose receipt storage and the tasks index, then the
application-owned reference transaction upgrades beta.1 session references to
derived `opcv1-` identities. Tasks/order, all users' marks, layout/preferences
and approval history survive; no historical request receipt is invented.
Operator config and generated auth bytes are not rewritten. The legacy
`opencode1` config alias remains accepted with one deprecation message.

User state belongs in `otk.db`; derived metadata belongs in the separate
worker's rebuildable `digest.db`. Background backfill exposes digesting
readiness without blocking the complete all-age catalog. `index.days` sets
priority, not retention. Directory catalogs and explicit provider-backed
recall/attachment reads remain volatile. Provider deletion retains
metadata/tombstones, never recoverable body history in OTK. Downgrade after
reference migration requires a consistent pre-upgrade state backup; see the root
upgrade instructions.

## Public discovery

The existing plain and tracked `/api/session` responses also carry `defaults`,
an allowlisted `{ defaultPort }` projection from the shipped
`defaults/otk.toml`. It never projects resolved operator/auth configuration.
Listener overrides do not change the advertised default; discovery's exact
response and CORS stay unchanged.

`GET /api/discovery` is reflectively discovered and returns only
`{ product: "otk", protocol, version, originAllowed, signIn }`. Versions come
from the protocol owner. `originAllowed` evaluates the request's Origin through
the same origin predicate as normal API admission; missing and opaque (`null`)
origins are not allowed. `signIn` describes the server requirement: `setup` for
unconfigured auth, `login` for password/TOTP, and `none` for auth disabled. It
does not describe or validate the caller's session.

This metadata is public even to a refused Origin. GET and OPTIONS on this exact
path alone use wildcard CORS without credentialed mode. Clients fetch it with
`credentials: "omit"`; cookies and Authorization do not affect its result, and
it never sets cookies or admits tracked requests. Responses are not cached, so
setup changes are visible on the next probe. No secrets, paths, configuration
values or backend identity are exposed. Other routes retain their existing
origin, auth and cookie behavior. Discovery adds no automatic time limit.

## Resumable request services

Native registrations use `nativeExecution` and `nativeEffect`: the core fences
independent backends before invocation, adapters repeat the fence at I/O, and
feature-owned encoders checkpoint only metadata. Creation/fork outcomes
checkpoint their returned identity before activation bookkeeping.
`RequestExecution.local` also commits post-native bookkeeping with its terminal
receipt after a checkpoint. `completion` validates that receipt independently of
the write callback's internal result, so a clock-producing write can retain its
clock while its wire result is null. Conflict resources are feature-owned; newer
admitted scope witnesses remain available while an older native outcome is
unknown, including after ordinary terminal-retention cleanup.

`BootstrapRequests` contributes setup/login/logout/discovery handlers to the
memory-only HTTP adapter. Its input equality and private receipt authorization
are origin-bound; credentials and cookie tokens never enter SQLite. Cookie
headers are retained privately and emitted/replayed only with their
corresponding successful terminal result. It exposes admission and event ports
for reflective HTTP route composition.

`RpcRegistry.prepare(method, params)` validates a feature's input without
running its handler. A registration can contribute `execution`: kind, target
scope, explicit metadata receipt encoder and recovery. Generic
registry/coordinator machinery imports no feature list. Existing in-process
`dispatch` remains usable.

`RequestCoordinator` composes a prepared registry, `Requests` repository and
injected `RequestPolicy`. Call `start()` before admission and join `stop()`
before closing storage. `window()` issues admission windows.
`accept(principal, control,
recipient)` acknowledges an admitted intent before a
later macrotask executes it. Principal, tab identity and intent key form its
duplicate fence; attempt IDs and recipient sockets do not. Per-principal/tab
admission retains input order across asynchronous fingerprinting, without
holding an executing turn or waiting for effect completion. Different wire
payloads cannot share an intent key. `detach` removes delivery only. Release
cancels the last read subscriber, while a native mutation remains tracked.
Same-session ready effects retain FIFO turns; declared reads and connection
leases do not join that effect queue. Readiness/I/O waits yield the turn and
ready continuations re-queue, so independent metadata can complete while native
is offline. Native effects additionally retain a separate same-session ordering
permission through their exchange: yielding never allows a second native effect
to overtake the first. Features whose metadata intents need lifetime ordering
declare `ordering: "target"`; their resource-keyed permission (method/session or
method/directory when no resource is supplied) preserves policy and membership
intent order. A resource witness alone never implies that permission. Task
closure, for example, proceeds during membership validation; the later write
must revalidate task ownership inside its transaction. An unrelated metadata
effect needs neither permission. Declared interrupt priority continues to bypass
ordinary effect order. `idle()` joins current owned work, not an assertion that
a genuinely uncertain native outcome has become terminal.

Strictly local registrations never resolve native identities. Native-validated
metadata uses `preparedLocalExecution` / `preparedLocalResultExecution`,
including task membership, seen, frecency and enable-only approval validation.
These are local effects in durable storage, preserving their existing atomic
receipts and restart recovery, but explicitly declare a native preparation
lifetime. Registry directory resolution rejects an undeclared native dependency
in a strictly local registration. Both metadata classes use
`ctx.execution.local(run, encode)`: pass its `StoreWrite` to every metadata
mutation so effect and completion receipt commit together. Feature-contributed
`RequestReceipts` are the only typed persistence vocabulary; read results remain
volatile. Intermediate `checkpoint(kind, receipt)` requires a registration-owned
runtime encoder. `beforeEffect()` commits the native dispatch fence; an unknown
post-fence outcome stays reconciling and is never redispatched. Recovery is
feature-owned, with reload allowed only for reads. Progress/liveness never
fabricates a failed result. `maintenance()` performs bounded receipt/cache
cleanup; active or unknown work is not expired to make room.

The existing unique-token interactive observation wraps actual handler work.
`ctx.execution.wait(promise)` releases that pressure and the coordinator's
executing turn while I/O or readiness is outstanding, then re-queues before
reacquiring pressure for the continuation. Native ordering permission is not an
executing turn. Late continuations cannot reactivate a finished handler. This
uses the existing digest scheduling input.

`readExecution(scope)` declares volatile, reloadable reads. The registry
observes their synchronous work and releases interactive pressure while their
returned promise is outstanding. Per-call cancellation reaches the selected
reader, including session-directory preparation. Connection leases remain
separate from read ownership.

`metadataReceipt(kind, parse)` composes a feature-owned runtime allowlist for
both completion encoding and restart rehydration.
`localExecution(scope, receipt)` and `localWrite(ctx, run, receipt)` join
metadata writes to the completion receipt; independent in-process callers retain
an explicit standalone write. Inbox, task, seen, preference/layout and approval
policy writes use these scopes. Deferred notifications observe the committed
completion. Preference receipts use the injected preference schema, including
external contributions, rather than a second global key list. Replaying a
receipt returns its original result without rewriting current projections or
reapplying visit clocks and frequency scores.

`HttpRequestAdapter` uses the same coordinator with `VolatileRequests`, not a
second request state machine. Compose it with selected bootstrap registrations
and pass an already-validated allowed origin. `admit` returns acceptance and
`events` holds an event-driven, receipt-authorized NDJSON response. A
client-held 256-bit secret is verified by hash; input equality uses a per-run
HMAC. Neither credentials nor their equality hashes enter SQLite. Optional
`resultHeaders` are emitted only with a successful terminal response, enabling
cookie replay without publishing headers early. Reflective HTTP routes remain
the application entry points; the adapter introduces no route or method-dispatch
table.

The layered `[requests]`, `[connection]` and `harness.requestms` policy leaves
are documented in the defaults. `clientRequestPolicy(cfg)` returns the exact
browser-safe subset. Services are independently composable; the shipped wire
continues to use its currently selected protocol contract.

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

The listener is reserved before backend startup and admits routes only after
startup completes. Signals installed by the process root cancel startup as well
as normal operation. Clean close retires pending digest callers with the shared
`StoppedError`, without reporting failure; real worker failures and shutdown
timeouts remain diagnostics. `isCancellation` is the protocol cancellation
classifier. The injected `DiagnosticSink` routes warn/info/debug through one
levelled output owner, filtering cancellation and repeated failure objects.
`[log] level` defaults to `info`; `OTK_LOG_LEVEL` overrides it. Ignored native
event types emit once at debug, with counts available on the adapter.

`RpcRegistry(backend, store)` dispatches registered methods and gives handlers
`RpcContext` (`harness`, `store`, authoritative `sessionDirectory(id)` and
`sessionDirectories(ids,signal?)`). Both identity paths use the harness's narrow
`identities` port rather than decorating session bodies. Collection mutation
validation deduplicates and reads one batch; missing identities reject only
after a successful authoritative read. Waiting releases interactive pressure and
read cancellation reaches that same validation. Task ownership is revalidated in
the local write scope after asynchronous provider validation. Features own
`params` validation and `handler`; `register(method, definition)` rejects
duplicate names. Invalid params and handler errors propagate to the WS request
owner. Unknown/unregistered methods return the existing `method` error. Method
names and handler results derive from the open protocol `RpcMethods` interface.
Validators still accept untrusted wire objects and may return their own parsed
representation; that representation types the handler's input.

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

`session.compact` requires a session ID and nonempty provider/model strings and
delegates to `sessionActions.compact` with the request execution context. Its
result joins the owned native HTTP settlement; admission is pending progress,
not completion. Native summary requests remain in the harness adapter.

`registerRevert` independently selects `session.revert` and `session.restore`
from the respective `revert` and `restore` capabilities. Both validate session
identity; revert additionally validates the boundary message. Neither operation
adds confirmation or overlap detection around the backend's native semantics.
The independently advertised `revertCode` port contributes `session.revertCode`;
its boundary receipt includes the requested mode. A boundary ID alone cannot
reconcile an uncertain mode change. Restore can reconcile a lost clear through
the capability's read-only `settle` port and persisted execution watermark.
`sessionArchive` independently contributes validated `session.archive` with a
metadata-only completion receipt, without expanding V1's capability contract.

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

Core forwards `bootstrap.complete` independently of `transcript.invalidated`.
The latter carries an ordered producer-generation/session-boundary version;
pages and turn detail carry the same authority marker. Metadata bootstrap cannot
discard an already-current transcript, and duplicate or delayed notices cannot
re-read newer authority. Native reconnect, instance disposal and revert-boundary
changes publish their invalidation at the actual boundary.

The same `[messages]` owner supplies browser scope cooling (`coolms`), temporary
attention leases (`preloadms`) and per-server page admission (`concurrency`).
Partial operator files merge leaf-wise before environment overrides. These
positive safe-integer thresholds do not change the fixed ten-message page size.
The same policy also supplies adapter-wide missing-seed read admission
(`recoveryconcurrency`) and fine identity capacity (`recoverypending`), through
the existing layered config and welcome decoder. No recovery-specific defaults
or timeout table lives in a library.

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
  readExecution,
  registerPrefs,
  registerPrompt,
  registerSessions,
  RpcRegistry,
  type ServiceConfig,
  startCore,
} from "./mod.ts";

async function run(backend: Harness, cfg: ServiceConfig, staticRoot: string) {
  const store = new OtkDb(cfg.state.path, [prefsMigrations], cfg.storage);
  const prefs = new Prefs(store, prefsOptions);
  const rpc = new RpcRegistry(backend, store);
  registerSessions(rpc, backend);
  registerPrompt(rpc, backend);
  registerPrefs(rpc, backend, prefs);
  rpc.register("example.directory", {
    params: () => "example-session",
    execution: readExecution(() => ({})),
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
immutable before/after snapshots. Only a proven terminal token records a finish;
status transitions cannot invent finish times. Activity clears persisted
inactive marks for affected users without tracking index-only directories.
Template discovery scans on startup and template edits, fencing retired/closed
results; snapshots carry these directory names independently of tracked
projects. Creation and successful action bookkeeping activate projects through
the existing store owner; viewing visits do not. Add project creates its initial
session. `Connections` consumes generic `FrameSource`s with welcome snapshots
and lifetime-bound listeners; it imports no inbox feature. The shipped
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

Policy IDs hydrate once into an enabled set and typed committed policy changes
maintain it. The existing MetadataChanges owner coalesces final policy keys and
journal outcomes within one write scope; rollback publishes neither.
Identity-bound dirty owners replace full-index scheduling: title, status and
digest-only changes perform no policy/journal reads or family scan. New pending
keys use one scalar batch journal-state read; committed journal outcomes
maintain those facts. The final synchronous current-policy and durable
confirmed/started checks remain at actual dispatch, preserving manual/automatic
serialization and uncertain-outcome fences. An equal native metadata publication
still signals changed pending-request metadata without inventing a new count.

Connections serialize each shared immutable broadcast/content frame once per
publication, then send that string only to matching live recipients. Scoped
request results retain their recipient-owned delivery. This changes encoding
ownership, not transport buffering or recovery policy.

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

## Directory acquisition

The layered `storage.busyms` leaf supplies the user-data connection's lock wait,
including standalone application examples. `digest.busyms` remains the
independent worker-file policy. Shared protocol feature bounds own title
validation and Activity page size; storage receives explicit lookahead limits
without importing protocol. Feature failures carry semantic size/title codes to
the one browser presenter, whose copy consumes those same immutable bounds.

Native directory catalog reads share the existing worker's feature-contributed
transient read channel, scheduler turns, native I/O permission and publication
credits. No second worker or durable catalog database is composed. Native
configuration remains authoritative for its instance lifetime; native lifecycle
and relevant catalog events invalidate demanded values. Only file discovery has
a project filesystem watch. Catalog results never become digest commits or
durable request receipts. The current compatibility RPCs borrow these services;
protocol17 directory leases and client resources borrow those same services. The
catalog feature selects open per-kind codecs through its local composition entry
and publishes metadata plus bounded complete-kind chunks, never a concrete kind
switch in transport. Generic request-owned leases remain releasable after their
initial result is received; socket disposal releases them too. Connection scope
hints retain their distinct connection-owned lifetime.

Provider-backed prompt recall and attachment batches use that same transient
read channel. Their feature-owned readers borrow the worker's existing native
SQLite connection; no serving-isolate history connection is composed. Global
header search yields between bounded chunks, and parts/synthetic shell commands
materialize by set. Attachment scalar validation precedes byte retrieval for the
whole batch. Typed byte fragments share publication credit and are assembled
only with contiguous offsets and complete lengths. Neither transient results nor
upload bytes become digest commits or durable read receipts. The layered
`attachments` policy is injected from the complete defaults into native read and
prompt/slash preparation; libraries do not read operator environment values or
invent policy defaults. The shipped `history.attachments` wire/client path
batches by original sidecar and preserves all-or-fail send preparation.
Transient read failures retain neutral certainty across the worker boundary:
definite input/attachment rejection completes with safe failure metadata, while
provider unavailability remains waiting under the existing request lifecycle.

Inbox hydration keeps one project/task/template/mark projection. Committed store
deltas update its keys; ordinary visits and seen/finish writes publish only
their changed facts. Complete baselines use a bounded asynchronous copy
operation, replay bounded dirty keys and perform no baseline SQL after
hydration. Connections subscribe before awaiting generic source snapshots;
closed sockets cancel assembly. The browser's inbox owner fences stale/gapped
baselines and patches independently of the session-index owner.

`ProjectSummaries` owns keyed scalar project status, session/unseen counts and
recency. Metadata/SSE and committed marks update contributions; digest-only
changes do no summary work. Inbox baselines include `summaries` and their
independent revision; additive `inbox.summaries` frames publish changed
projects. Automatic-permission coverage borrows the existing policy owner.
Population authority is independent of supervision. Stale live evidence stops
counting. No row requires session metadata to render its lamp or counts.

Optional seed topology adds worktree leaves beneath their canonical repo. The
summary owner preserves direct-checkout counts and deduplicates repo rollups;
hydrating a session does not add to seeded population counts. Inbox keeps local
Inactive policy independent per directory. Mandatory activity restores its own
leaf and repo context, never quiet siblings. Tasks, marks, ordering and exact
execution directories are not rewritten when topology arrives or changes.
Checkout summaries retain their exact source-directory `scopes`. View leases
borrow those scopes for task and mandatory metadata without changing native list
or stored task identities.

## Worker-backed digest services

Derived units carry their own pending/unavailable/known result independently of
refresh activity. Known values retain their source witness and finality through
store migration, bounded multipart replay, both index reducers and helper
content patches. Transport completion cannot certify or revoke a value. Worker
unready notifications mark refresh/staleness, without changing retained results.
The single SQLite owner, scheduler, publication credits and cancellation fences
are unchanged.

Socket view lifetimes retain viewer presence even for an empty welcomed view.
Optional digest/helper batches and cached replay require a request-free
`digest.idlems` interval. HTTP ingress and validated WS acquisition requests
reset that interval independently of executing pressure; passive
acknowledgements and server events do not. Priority promotion never changes idle
eligibility. `digest.parallel` bounds admitted optional entry-batches, including
I/O waits; the single native permission and SQLite owner remain unchanged. A
request parks the next batch while bounded commit/publication cleanup drains.
Without a viewer, optional work parks unless `digest.background` is enabled
(default off); interruptible reads join cancellation before parking. Scalar
catalog facts and SSE activity/permission updates remain independent so lamps
stay live. The existing native permission is also borrowed by serving-isolate
finite reads; essential page demand preempts optional I/O without adding a
SQLite owner.

Indexed ready queues order interactive, attention, visible and background work.
Session pages supply an inclusive oldest-message metadata boundary. Its scalar
backfill runs newest-first at interactive priority to that boundary, then
retains high membership for one bounded batch per idle break. Consumed list rows
enter normal membership; completion retires either membership. Only after both
sets drain does bounded most-recent discovery reach other Active projects. Inbox
owns the project-policy input, including inactive exclusion and activity
lifting. Boundary coverage is independent of full-history readiness and
stale-row sweeping. Progress totals stay unknown while source enumeration
remains incomplete.

Catalog metadata uses attention priority; rebuildable replay uses background.
Committed bounded publications inherit their producer's rank and drain as
finishing continuations, preserving ordering even under interactive pressure.
Cached replay instead parks between credited chunks. An essential successor
donates its rank and readiness only along its identity's predecessor chain;
unrelated replay remains parked, and canceled successors withdraw their
donation. Row/time quotas and measured serving reduction costs share the duty
budget. Adaptive row quotas retain a floor of `ceil(digest.batch / 8)` (at least
one); the same floor applies when a native keyset stops at its time boundary.
This limits time-budget subdivision to eight slices instead of per-row native
reads.

The worker's incremental DigestProgress owns scalar scope generations, bounded
enumeration denominators, completion/queue/chunk/message counts, active work
time and actual wait reasons. Its one-second fact stream crosses the bridge
through a view-scoped FrameSource; it opens no progress-only SQL reader or
history scan.

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

Waiting is not work: credit, native I/O admission/body settlement and lock
readiness release the executing turn. Ready continuations re-enter the same
scheduler at their priority, with essential reads between bounded publications
and SQL chunks. Native I/O retains a separate serial permission; its deadline
starts only after admission, and cancellation joins actual settlement before
reuse. Derived SQLite uses fail-fast lock admission and cooperatively retries
within `digest.busyms`. Async request state is lifetime-local. Per-identity
publication reservations and revision-consistent temporary scalar snapshots keep
interleaved chunks coherent; neither contains message bodies. Committed ordered
publications run in independent essential turns and release their reservations
before resuming producers, so interactive pressure cannot pause a predecessor
needed by an essential read or deletion. Startup acknowledges without replaying
retained sessions. Project seeds stream grouped population facts under
publication credit, after project-table identity proof. View demand hydrates
only selected, task and mandatory keys and ancestors, including retained
tombstones. Persisted unseen routing keys survive restart independently of list
acquisition. Stop retires caller gates immediately and joins queued/waiting
cleanup before closing the worker's single SQLite owner.

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
`ctx.execution.signal` reaches usage detail: `request.release` releases only
that recipient's matching read, cancelling demand when its last subscriber
leaves. Unknown/completed release identities are harmless. The registry's
injected observation callback uses unique dispatch tokens for interactive
pressure. Mutation handlers do not consume read cancellation.

Inbox observers use hydrated project policy and seen/finish projections, updated
by committed store changes. Proven terminals commit without a follow-up SELECT;
digest observations perform no baseline SQL reads. Tombstones retire approval
policy without creating synthetic finish edges.

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
commit in bounded row batches before their jobs are admitted, with batched
summary lookups and real event-loop yields between chunks. Optional injected
diagnostics observe serving sections and worker pressure/native read counts;
they introduce no operator flag or public debug RPC.

The worker composes neutral/native digest feature v2 for helper progress. Helper
jobs share scheduling, connection ownership, row budgets and publication credits
with header jobs, while ordinary header backfill reads scalar timing projections
but no part bodies. Optional helper API slices are cancellable at essential-read
admission and retain their reconciliation intent. Only scalar helper identities
cross invalidation ports; tools, labels, scan generations and helper summaries
commit on the worker's one derived connection. Catalog/restart publications
carry cached helper metadata.
