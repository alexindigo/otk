# @otk/harness-opencode-v2-server

Local, read-only discovery of the stock opencode V2 background service. The
Promise client is pinned to 2.2.6. This package never starts/stops the service,
signals its process, or writes its database. Native session IDs use `opcv2-`.

`discoverV2(file)` preserves missing, unreadable/malformed, stale identity,
unreachable, incompatible JSON and authentication failures before calling
`Service.discover`. Headers come from `Service.headers` (UTF-8 Basic auth). The
application resolves HOME/XDG paths and selects auto/V1/V2; credentials never
enter neutral protocol frames or browser config.

`V2Client.read` owns finite reads, cancellation and error classification. The
SDK stays private. Native not-found tags establish absence; transport, timeout
and malformed responses remain unavailable. Per-read async context carries
caller cancellation through concurrent SDK calls, and aborted continuations
cannot return late data. `effect` fences each native exchange immediately before
I/O, has no finite mutation deadline, and retains ambiguous outcomes as unknown.
`sequence` serializes a whole same-session operation, including preparation,
selection checkpoints and final settlement. Disconnect aborts and joins effects.

Session actions use authoritative GETs after 204 metadata updates. Archive and
code revert are independently advertised; V1 does not acquire either capability.
Fork translates inclusive `through` to native exclusive `before` by source
order, caps it at a staged revert, and maps proven empty prefixes to new empty
roots. Its bounded fallback releases every body page and retains only scalar
boundaries.

Revert stages with `files:false`; Revert code changes stages with `files:true`.
Neither commits or clears. Re-staging changes mode without waking execution.
Restore clears only an existing stage, persists a pre-clear execution watermark,
and joins native wait plus fresh terminal clocks. Lost clears reconcile through
a read-only settlement port, never another clear. Only a successful next native
prompt makes the history removal permanent. Preview reads retain at most 50
oldest prompt previews and metadata-only recalled attachments. Mode-aware
receipts never infer a lost code-revert outcome from its message ID alone.

Shell remains non-LLM. Commands prepare all selected files before selection
changes; successful switches checkpoint metadata before final dispatch. Commands
and compaction join native settlement when called with an operation context.

`V2Stream` owns one subscribed SSE generation. It waits for `server.connected`
before snapshot reads, stages events under the injected operation/byte budgets,
deduplicates durable positions and IDs, and pauses its 45-second byte watchdog
only for owned parser backpressure. Reconnect re-discovers credentials and
resyncs before readiness. Snapshot acquisition returns a fenced commit; abort
joins acquisition and event work before closing. Execution facts survive
decodable frames whose unrelated fields drift. The SDK event queue is unused.

The transcript owner maps all native message kinds through one snapshot/tool
mapper. Native controls update selection, not fabricated prompts. Source
sequence orders fork copies independently of their copied timestamps and
non-sortable IDs; synthetic/system/skill/shell/compaction rows never become
real-prompt anchors. Text and reasoning identities count their own ordinals;
tools use call IDs.

Pages contain ten native rows, chronological visible items, session metadata,
real-prompt/reply context and an event-aligned replay clock. Cursor
continuations omit native `order` and bind to session, epoch, cutoff and source
identity. Reconnect stages demanded running-turn backfill and checkpoints
retained streams before new deltas. Missing seeds use bounded replacement-only
recovery; HTTP snapshots never become append seeds. Unsubscribe, cutoff,
reconnect and stop fence late pages, recoveries, shell output and speculation.

`OpencodeV2TranscriptDigestSink` is the transcript contribution selected by the
existing worker. It borrows that scheduler, credited read channel and derived
SQLite owner, opening one read-only, schema/identity-checked native connection.
Background headers and helper rows exclude text, tool inputs and output. API
fallback extracts and releases bounded pages. Reported usage remains nullable;
native session totals include internal charges and need not equal reply ledgers.
This contribution does not enumerate projects or session lists; V1 owns those.

Q6 prefetch reads only the next older page under the existing optional/idle
admission. Its adapter-wide memory-only FIFO charges complete encoded keys and
payloads, expires from insertion and rejects oversized entries. Hits skip native
body and scalar metadata acquisition and seal a new replay clock. Mutations,
metadata replacement, source/boundary changes and retirement cancel cached and
in-flight authority; speculation never recursively fetches another page.

## Existing-state upgrade boundary

V1 will prove imported native identities using the worker's read-only source
identity check before invoking an OTK-only transaction. The existing reference
upgrade now accepts a distinct marker, strict collision handling and injected
feature-owned metadata-reference contributions in that transaction. No blind
`opcv1-` replacement is performed at V0 startup. Unproven/deleted/foreign IDs
must survive unchanged. Scope and allowlisted metadata receipts join the
reference transaction; request fingerprints, certainty, dispatch clocks,
journals and terminal retention must survive unchanged. No native body or
credential may enter a receipt. The marker commits only with every contributor.

Tests: package contracts, `test:v2-foundation` and `test:v2-transcripts`, inside
the assigned droplet. Native selection runs in both lanes. No V2 parity area is
claimed merely by preparing a native binary or selecting a browser project.
