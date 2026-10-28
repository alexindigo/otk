# @otk/harness

Harness-neutral session and lifecycle contracts, `HarnessSink`, `HarnessError`,
and typed optional capabilities. Depends only on `@otk/protocol`. Import the
public entry `@otk/harness`; native schemas and endpoints belong to adapters.

Session references use the protocol's qualified-ID grammar. An adapter owns its
native codec and validates its own provider at the boundary; the shared harness
contracts never infer a provider from a bare native identity.

`HarnessCore.listMessages(id, {before?}, signal?)` returns a clocked ten-message
`MessagePage`; the optional cursor is opaque outside its adapter. Session
metadata and latest-prompt context travel with the page. `HarnessSink.content`
accepts the producer's optional third `ContentClock` argument; paged producers
must supply aligned clocks, including standalone integrations.

`ContentReplay` owns per-session epochs/sequences and bounded
capture/seal/release. Its constructor receives operation/UTF-8 byte budgets, a
nonce source and an emit port. Overflow invalidates a capture and releases its
payload; seal never returns a partial success. Reset/retirement invalidates
captures and continuation authority together. It has no native reader, parser,
database or UI dependency. `DigestPort.transcriptMetadata` is a cancellable
scalar-only worker read for the latest user header, requested turn boundaries
and optional rollback creation clock.

```ts
import {
  CapabilityRegistry,
  type Harness,
  requireCapability,
} from "@otk/harness";

const registry = new CapabilityRegistry();
registry.register("history", {
  listHistory: () => Promise.resolve([]),
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
content operations and resync notifications. Capabilities do not own the sink.
`SessionIndex` owns session metadata. A consumer can supply that owner as
`HarnessSink.index`, with index callbacks writing it; the native connector reads
the same owner instead of retaining a second copy. Omitting it preserves the
standalone sink API. The application index extends this owner with wire batching
and revision notifications.

License: LGPL-3.0-only. Workspace validation: `deno task test:unit` and
`deno task test:arch`.

## Digest services

`DigestPort` separates catalog/detail reads and their cancellation from metadata
invalidations, visible-scope priority, deletion intents and lifecycle. Libraries
receive `DigestPolicy`; they do not read application environment variables or
invent policy defaults. `DigestSink` owns provider work and durable cursors.

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
session work. `tick()` executes one slice: interactive reads (`execute`) precede
attention, visible scope and background. Owner-keyed scopes form a union;
`release` drops an owner's scope and interactive demand. Background pauses under
memory pressure or interactive demand; essential reads still run. Continuations
retain cursors, fine-grained keys collapse to retained full-session markers, and
observed elapsed time controls the duty limiter. `stop` aborts and joins active
work and closes every selected sink.

Essential reads interrupt the actual duty wait. Its remaining quota still gates
the next background slice, so yielding cannot turn a slow background read into a
long admission stall or discard the configured duty limit.

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
