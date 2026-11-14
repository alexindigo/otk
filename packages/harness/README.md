# @otk/harness

`HistoryReadKinds` contributes global recall, keyed recall entries and ordered
attachment batches to `ProviderReadKinds`. These are volatile requested results,
separate from metadata-only digest publications. `historyAttachmentCodec`
fragments upload base64 into bounded pieces under ordinary publication credit,
validates identity/offset/size continuity and exposes only complete uploads.
Selected native readers and codecs are composed through the existing open maps;
the scheduler/transport has no dispatch switch on history method names.

Harness-neutral session and lifecycle contracts, `HarnessSink`, `HarnessError`,
and typed optional capabilities. Depends only on `@otk/protocol`. Import the
public entry `@otk/harness`; native schemas and endpoints belong to adapters.

Session references use the protocol's qualified-ID grammar. An adapter owns its
native codec and validates its own provider at the boundary; the shared harness
contracts never infer a provider from a bare native identity.

`ProjectSeed.identities` supplies native source/repository identity, canonical
locator, recorded checkout boundary and complete or unavailable inventory. Every
native owner survives grouped reads, including owners sharing a directory. The
application's ProjectIdentity alone resolves durable checkout membership and
persists learned boundaries. Inventory pruning changes availability, never
affiliation. An unknown boundary stays an unresolved location under its known
repository. Native source locators namespace facts; current filesystem state
never establishes membership. Seeds remain grouped scalar population facts, not
session catalogs. Injected harnesses may still supply `topology`; omitted facts
retain history and null means removed availability, not a retired relationship.

`HarnessCore.identities(ids, signal?)` is required for authoritative identity
validation. It returns one `{id, directory, parentID?}` row per extant requested
identity, with duplicates removed. A successful missing row means not found; an
unavailable provider rejects instead of returning cached facts or an empty
success. This port never reads message bodies, usage, revert previews or
Markdown.

`HarnessCore.listMessages(id, {before?}, signal?)` returns a clocked ten-message
`MessagePage`; the optional cursor is opaque outside its adapter. Session
metadata and latest-prompt context travel with the page. `HarnessSink.content`
accepts the producer's optional third `ContentClock` argument; paged producers
must supply aligned clocks, including standalone integrations.

The optional `listMessages` input `publish(page)` delivers one atomic
coordinated body page before scalar metadata coverage finishes. The returned
page completes that same boundary; it does not require another native body read.
Cancellation and producer-version fences apply to both deliveries.

`HarnessCore.listSessions(input, signal?)` returns bounded metadata, an opaque
continuation and source generation. `sessions.list` contributes the same read to
the existing provider-read channel. List coverage is independent of index
membership. Consumed rows join normal digest work; exactly one successor list
page joins idle-gated high-priority work. Prefetch never recursively enumerates
successor pages, and shares optional batch admission with session work.

`ContentReplay` owns per-session epochs/sequences and bounded
capture/seal/release. Its constructor receives operation/UTF-8 byte budgets, a
nonce source and an emit port. Overflow invalidates a capture and releases its
payload; seal never returns a partial success. Reset/retirement invalidates
captures and continuation authority together. It has no native reader, parser,
database or UI dependency. `DigestPort.transcriptMetadata` is a cancellable
scalar-only worker read for the latest user header, requested turn boundaries
and optional rollback creation clock.

`ContentReplay.version(id)` supplies the producer generation and
session-boundary revision on every page. `invalidate(id?)` advances that ordered
version, retires captures and returns the notice for `HarnessSink.invalidate`.
Reconnect and instance disposal advance the generation; a changed revert
boundary advances only its session revision. `reset`/`release` retire demand
epochs without inventing a provider invalidation. Versions are scoped to one
producer lifetime; a new welcome establishes a new transport/baseline lifetime.

`HarnessSink.bootstrapComplete()` announces completed metadata bootstrap. It is
independent of `invalidate({version, sessionID?})`, forwarded as
`bootstrap.complete` and `transcript.invalidated` respectively. Bootstrap
completion cannot invalidate a current transcript. A consumer already at the
notice's version (or newer) does not reacquire that page or opened turn detail.

```ts
import {
  CapabilityRegistry,
  type Harness,
  requireCapability,
} from "@otk/harness";

const registry = new CapabilityRegistry();
registry.register("history", {
  listHistory: () => Promise.resolve([]),
  attachments: () => Promise.resolve([]),
  attachment: () => Promise.reject(new Error("No attachment")),
});
console.log(
  await requireCapability(registry.capabilities, "history").listHistory(),
);

async function readChildren(harness: Harness, id: string) {
  return await harness.core.listChildren(id);
}
```

A harness pairs `core` (identity, start/stop, subscriptions, session creation
and queries) with `capabilities`. Prompt/abort, shell, commands, history, files,
agents, models, resources, permissions, questions and revert are optional.
History reads and attachment retrieval are asynchronous. Consumers check or
require a capability at their operation boundary. Missing and duplicate
registrations raise a `HarnessError` with code `capability`. Registry snapshots
are frozen; the supplied capability objects retain their identity and lifetimes.

The name and operation contract lives in `@otk/protocol`'s open
`CapabilityContracts` interface. This package re-exports its `Capabilities`,
`CapabilityName` and shipped operation types. A feature augments that protocol
interface beside its code; registry registration, `requireCapability`, wire
advertisement and client/UI availability then share the same typed name.

The core owns lifecycle; call `stop()` to release its streams and outstanding
operations. A sink receives connection state, index snapshots/updates/removals,
content operations, bootstrap completion and versioned transcript invalidation.
Capabilities do not own the sink. `SessionIndex` owns session metadata. A
consumer can supply that owner as `HarnessSink.index`, with index callbacks
writing it; the native connector reads the same owner instead of retaining a
second copy. Omitting it preserves the standalone sink API. The application
index extends this owner with wire batching and revision notifications.

License: LGPL-3.0-only. Workspace validation: `deno task test:unit` and
`deno task test:arch`.

## Digest services

`ProviderReadPort` extends the same worker/scheduler lifetime with transient,
feature-contributed reads. `identity.batch` contributes its input/result/chunk
types and `identityReadCodec`; application composition selects the matching
reader and codec. Reads carry an owner, priority and cancellation signal, and
may explicitly opt into optional idle/parallel admission for speculation,
publish bounded ordered chunks, and assemble one complete result. Releasing the
owner cancels its pending reads. These results are not digest commits or durable
request receipts.

Directory catalog features contribute typed native reads and codecs through that
same open surface. Array values use bounded row slices; model framing preserves
provider identity, connected-model metadata and configured defaults, rejecting
duplicate or undeclared identities. Typed file listings preserve their physical
directory identity across chunks. The executor imports no concrete catalog-kind
dispatch. `ReadAdmission` is the shared I/O-permission owner used by worker and
standalone scheduling: waiting for permission does not occupy an executing turn,
and cancellation joins the actual native exchange before permission is reused.

Directory subscriptions retain a resource without acquiring its kinds. Per-kind
warm intent uses background priority with no optional idle gate; consumer intent
uses user priority. Promotion cancels and joins an unfinished acquisition before
restarting it in the same kind lifetime. Complete last-good values, invalidation
and native-generation fences remain owned by that resource. Refresh can select
kinds; unused catalogs and unopened directories are not bootstrapped.

`DigestPort` separates catalog/detail reads and their cancellation from metadata
invalidations, visible-scope priority, deletion intents and lifecycle. Libraries
receive `DigestPolicy`; they do not read application environment variables or
invent policy defaults. `DigestSink` owns provider work and durable cursors.
`detail(sessionID,turnID,signal)` returns a scalar `TurnUsageSnapshot`; the
adapter captures its content checkpoint before the worker read and supplies the
wire `TurnUsageDetail`. Detail identity and cancellation survive chunked worker
publication. Complete charged calls do not depend on visible transcript pages.

Its generation-fenced `deleted(connection,sessionID,revision,metadata?)` input
expresses accepted provider deletion authority, distinct from a presence
invalidation that still needs reconciliation. Repeated/stale notifications
cannot retire another native lifetime. Content bodies never cross this port. The
optional `publishrows` budget lets adapter catalog reconciliation yield between
bounded live-metadata publications using the injected worker policy.

An authority fact that may precede cataloging carries its allowlisted last-known
metadata. A publication can seed that newly retained identity before its first
digest delta, so accepted deletion remains durable even while provider health is
unavailable.

`DigestScheduler` registers sinks by declared identity and coalesces queued
session work. `tick()` executes one runnable turn: interactive reads (`execute`)
precede attention, visible scope and background. Owner-keyed scopes form a
union; `release` drops an owner's scope and interactive demand. Background
pauses under memory pressure or interactive demand; essential reads still run.
Viewer-aware compositions initially call `viewers(false)`; a welcomed scope,
including an empty one, supplies presence. `requested()` resets the idle gate
independently of executing pressure. Queued digest batches are explicitly idle
work regardless of priority; `execute` callbacks are requested/essential unless
their owner explicitly classifies them as optional. Idle work also needs
presence or `policy.background`, and `policy.parallel` bounds admitted
entry-batches, including waiting ones. Last-viewer release parks optional work
only when background is disabled. Admitted batches drain bounded cleanup before
parking. Indexed heaps repair changed priorities at admission/scope changes
rather than scanning the pending population per tick. Bounded finishing
continuations retain their inherited rank while draining committed publication
and I/O cleanup. Continuations retain cursors, fine-grained keys collapse to
retained full-session markers, and observed active work controls the duty
limiter. `stop` aborts and joins active work and closes every selected sink.

Essential reads interrupt the actual duty wait. Its remaining quota still gates
the next background slice, so yielding cannot turn a slow background read into a
long admission stall or discard the configured duty limit.

Waiting is not work.
`execute((signal, execution) => ..., signal, priority?, interruptible?)` and the
sink's fourth `step` argument supply one `DigestExecution` per lifetime.
`execution.wait(readiness)` releases its turn, then queues the ready
continuation at that job's priority; publication credit, locks and other
readiness cannot hold execution. `wait(readiness, 'io')` also identifies
interruptible native reads. Essential reads can retire an unfinished background
I/O slice while retaining its durable reconciliation cursor. Cleanup uses
`execution.join(readiness)` to join actual I/O settlement before releasing
permission. No SQLite transaction crosses a wait. Duty accounting excludes
waiting time; its timer is outside the executing slot. Producers must use these
ports for asynchronous readiness.

Ready requested turns precede idle batches and continuations even when an idle
entry has an attention hint and the requested read has visible priority. The
existing finishing queue still drains bounded committed publication and cleanup
at its inherited rank; cancellation retains its cleanup precedence.

Explicit transient read callbacks can opt into `interruptible: true`. Urgent
native I/O then cancels their lower-priority acquisition, joins settlement and
requeues the same caller lifetime at its original priority. The callback may run
again: it must be read-only and must finish acquisition before publishing a
result. Ordinary callbacks and interactive peers are not replayed. Caller
cancellation or shutdown retires the lifetime instead of retrying it. Worker
provider-read contributions and the standalone native catalog executor select
this option at their existing read-only composition boundaries.

Worker compositions also yield the actual event loop between bounded turns so
incoming cross-isolate messages can enter the priority queue. Catalog writes and
admission use row-budgeted committed batches; no SQLite transaction crosses a
yield and no inventory-sized synchronous pass stands ahead of essential reads.

`SessionIndex.upsertMetadata`/`resetMetadata` preserve existing summaries and
tombstones; `applyDigest` preserves live title/status/attention/topology and
rejects lower digest revisions. New identities materialize as digesting revision
0 with empty turns. Catalog reconciliation retains absent identities: only a
separate authoritative deletion path may tombstone them. The original explicit
`reset`/`remove` operations remain available for connection/window eviction.
Publication subclasses override hooks rather than maintaining another entry map.

`snapshotEntries()` borrows stable, deeply frozen entries for serialization.
Field-owned writes replace those immutable entries, so a captured snapshot stays
consistent while later metadata/digest changes arrive. `get()` and `values()`
retain their detached mutable-read contract. Transport can serialize the one
authoritative index without cloning every retained turn first.

`getMetadata(id)` returns detached live metadata and deletion state without
traversing the digest or turn history. Native status, error and attention owners
use this narrower read; topology traversal likewise stays independent of turn
count. Complete digest consumers keep the existing `get()`/`values()` ports.

Helper work is a separately keyed `DigestIdentity.projection: 'helper'`, using
the same scheduler. Background slices yield on essential-read admission without
losing their queued cursor. `helper` invalidations express changed scalar
identities; `helper-hint` only requests missing progress.
`SessionIndex.helper(id)` borrows a detached scalar summary and
`observeDigest(listener)` reports accepted keyed digest changes, without another
metadata index. Helper-only deltas preserve unchanged turn branches and live
status/attention; `helper: null` explicitly removes the derived summary.
