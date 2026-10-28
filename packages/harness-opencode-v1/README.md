# @otk/harness-opencode-v1

Stock opencode 1.x implementation of `@otk/harness`, verified against 1.18.34.
All neutral session references are derived `opcv1-<native>` identities. The
public `opencodeV1SessionID` codec is the only native boundary owner: native
rows/envelopes remain native, while core/capability inputs and mapped outputs
use qualified IDs. Message, part, request, task and model IDs are unchanged.
Bare or foreign-provider session IDs reject before native I/O; `legacy` is only
for the application's startup data upgrade, never wire admission. All native
endpoints, raw shapes, cursor encoding and read-only database projections live
here. Depends only on `@otk/protocol`, `@otk/content` and `@otk/harness` plus
the existing pinned standard path library and Node SQLite.

```ts
import type { Harness } from "@otk/harness";
import { OpencodeV1Adapter } from "@otk/harness-opencode-v1";

const harness: Harness = new OpencodeV1Adapter({
  harness: {
    url: "http://127.0.0.1:4097",
    username: "opencode",
    password: "",
    db: "/home/tester/.local/share/opencode/opencode.db",
    heartbeattimeout: 25,
    reconnectmax: 30,
  },
  index: { days: 30 },
  messages: { replayops: 128, replaybytes: 4194304, retryms: 1000 },
});
try {
  await harness.core.start({
    connection: (state) => console.log(state),
    indexReset: (sessions) => console.table(sessions),
    indexUpsert: (session) => console.log(session),
    indexRemove: (id) => console.log("removed", id),
    content: () => {},
    resync: () => {},
  });
  // Keep the consumer alive while observing the index stream.
  await new Promise((resolve) => setTimeout(resolve, 5000));
} finally {
  await harness.core.stop();
}
```

Run a consumer with Deno's network/read/environment permissions. No OTK sidecar
is required; start a stock server separately. Empty `db` resolves through
`XDG_DATA_HOME`/`HOME` using the native default. There are no sidecar auth/state
inputs. Optional capabilities are implemented in feature-owned modules and share
one session-directory resolver. Use `core` for lifecycle/session queries and
`capabilities.<name>` for optional operations. The adapter exposes the same
honest optional capability map as `Harness`; consumers check or
`requireCapability` at their operation boundary. Augmenting the open protocol
contract never promises that this stock adapter installs that port.

`sessionActions.rename` resolves the target's directory and sends native
`PATCH /session/{id}` with `{title}`, returning the neutral mapped session. The
ordinary native session-updated event remains authoritative for the index.
`sessionActions.remove` sends native `DELETE /session/{id}` in that same
resolved directory. The existing native deletion-event path owns disposal of the
session and its helpers; callers abort working sessions before removal.

`sessionActions.fork` translates OTK's inclusive `through` to the next native
message ID before `POST /session/{id}/fork`. `BootstrapDb.nextMessageID` reads
one scalar, with bounded Messages pages as fallback. Both whole-session and
response forks cap the native boundary at an authoritative pending revert.

`sessionActions.compact` launches native `POST /session/{id}/summarize` with
`{providerID, modelID}` through the existing owned request lifetime and
`timeout: null`. Admission returns immediately; progress, completion and HTTP
failures reconcile through ordinary session events/errors. Native summarization
joins current work and commits a pending rollback, as the next prompt does.

The shared HTTP failure mapper reads both legacy `{name,data}` errors and native
`_tag` errors with top-level reasons/references (`_tag` takes precedence over
resource fields such as an MCP server's `name`). Busy and identity-bearing
not-found errors use fixed user-facing messages, including legacy storage
diagnostics. Other readable reasons pass through the protocol helper only when
they contain no native opaque ID or identity supplied by the envelope. Missing
or identity-bearing fallback reasons receive plain HTTP-status text, never raw
JSON or resource IDs. Machine-facing kind/reference metadata remains separate
from display copy. This HTTP boundary owns the mapping for every caller.

`restore.restore` posts `/session/{id}/unrevert` in the resolved directory and
returns the authoritative session. Revert projections include up to 50 oldest
rolled-back prompt previews and the boundary's metadata-only history entry.
`BootstrapDb.revertedPrompts` bounds SQL rows; missing schemas use the existing
bounded Messages scan without retaining a transcript. History lists and point
entries share one mapper, including upload references without bytes. Live revert
operations and reload snapshots carry the same projection.

The adapter retains ownership of events, stream buffers, task watchers, admitted
shell/command requests and reconciled HTTP/SSE errors. Stop aborts and joins
owned requests and releases readers. History lists contain metadata, not upload
bytes; `capabilities.history.attachment({ messageID, partID })` retrieves those
bytes asynchronously. Missing/incompatible databases degrade to empty history
without creating or writing them.

Explicit path attachments are required: normal prompts and slash commands
resolve every selected path and check file-read or directory-list access before
native admission. A missing or unreadable path rejects the whole send with an
`attachment` error naming that path, so the caller retains its draft and chips.
The mapper never omits a submitted part. Only best-effort file discovery may
skip unavailable candidates. Paths remain native file references; these checks
do not copy file contents or prevent subsequent external filesystem changes.

Native image file parts retain their original URL in the neutral transcript
mapping, shared by snapshots and live updates. Uploaded image data URLs
therefore reach the browser without a second retrieval path. Non-image file
metadata does not gain upload bytes. History listings still exclude upload bytes
and fetch them only through the existing attachment operation.

Core and connector share one `SessionIndex` through `HarnessSink.index`; a
standalone consumer may omit it and use the adapter's default owner. A malformed
event or failed event follow-up is logged without reconnecting unrelated
sessions. Transport, watchdog and authoritative bootstrap failures retain
reconnect behavior. Request attention changes touch only the owning session and
ancestor path; reparenting updates the affected subtree, including late-arriving
parents. Agent colours share one in-flight/cache entry per directory until
native instance disposal or stop. Reconnecting alone does not invalidate
directory configuration.

Selected-digest bootstrap uses the injected publication row budget for catalog
preparation as well as final writes. Attention reconciliation yields one step
per row or ancestor, preserving exact helper counts without an inventory-sized
pre-publication block. Live index lookups use the shared owner's metadata-only
read rather than copying historical turn summaries for status/error handling.

Agent-colour reads are optional directory resources, never prerequisites for a
history page or live header. Essential content uses available colours
immediately; late colours publish `agent.colors` to current subscribers, whose
existing transcript is decorated by the client reducer. No second message/header
store is retained. Failed lookups are diagnosed once per attempt and can retry
on the next read. Disposal cancels the resource and fences its late results;
unsubscribe releases its session identity. Task refresh failures likewise report
the affected live parent only, continue independent links and suppress
retired-parent errors; they do not cause a connection-wide resnapshot.

The connector's pending-permission owner retains normalized requests from
bootstrap and global permission events. Family list readers, attention counts
and tool waiting state use that same owner, including with no content
subscriber; replies remove entries through the native event. Readers receive
detached values rather than making another live HTTP inventory request.
Bootstrap replaces its pending metadata atomically only after the snapshot
succeeds. This avoids losing an otherwise valid event request when
stock1.18.34's live inventory encoder rejects optional tool metadata (observed
websearch metadata.livecrawl). Each pending entry also retains its
asking-instance directory from the global event envelope or per-directory
bootstrap listing. Replies route to that instance, falling back to the shared
asynchronous directory resolver when no pending route exists; directory is never
omitted. This routing metadata stays internal rather than becoming part of the
neutral request returned to readers.

Before publishing connection readiness, bootstrap inventories status,
permissions and questions only in directories hinted as possibly running by
compatible read-only SQLite. An authoritative empty hint list makes no native
inventory requests: directory reads create native instances and touch project
visit clocks. Missing, unreadable, incompatible or failed SQLite reads instead
use every distinct directory in the paginated, index-window session snapshot,
with at most four directories in flight. This fallback keeps already-running and
blocked sessions visible without a database, on connection or instance resync.

Each start owns one reconnect loop; a repeated start rejects without replacing
its sink, including while stop is pending. Stop cancels and joins that lifetime
before another start is accepted. Each connection owns health, paginated
bootstrap, native inventories and ordered event work with one cancellation
signal. Finite native reads retain their deadline alongside caller cancellation;
streams and explicitly unbounded requests retain their existing timeout policy.
Cancelled generations cannot publish snapshots, readiness, resyncs or late event
results. A directory inventory failure cancels and joins only that directory's
sibling reads, logs its directory and retains previously known activity/input;
healthy directories still reconcile and the connection becomes ready. Failures
of the authoritative session snapshot still reconnect. Repeated connected frames
cannot launch overlapping snapshots. Instance-disposal resync uses the same
connection owner and cancellation fences.

All publication methods share a connection-scoped sink that permanently drops
calls after abort; asynchronous event work captures that port. Bootstrap stages
at most 128 accepted events and a 4 MiB serialized UTF-16 text estimate, plus
the parser's one in-flight frame. Below that window the parser keeps observing
transport heartbeats. At its limit, backpressure holds the next frame until
bootstrap and ordered replay finish; the byte watchdog pauses only while that
owned backpressure prevents observing bytes. Finite bootstrap request deadlines
and cancellation still apply. No event is dropped to meet the staging budget.
Transport closure can cancel held bootstrap reads without consuming more events.
Task summaries share one initial child scan and one in-flight refresh with a
trailing dirty flag. Parent release aborts scan/read lifetimes and stop joins
their actual completion; one failed link cannot affect independent parents.
Explicit session deletion releases pending input and direct attention, task and
revert ownership, optional colours, recovery, commands and buffers together.
Error observations are admitted independently of the index window. Empty-state
revisions borrow the authoritative index, or live only with an active
out-of-window subscriber/request. Unsubscribe releases those empty consumer
clocks. Deletion fences last until the next accepted snapshot generation; old
HTTP tokens remain invalid after that barrier. Reconciliation releases unowned
observations rather than retaining busy/cleared keys and old-generation deletion
metadata forever.

`capabilities.models.listModels(sessionID)` reads native `GET /provider` and
`GET /config` in that session's directory. It allowlists connected provider and
model display metadata, including finite positive native `limit.context` as
`contextLimit`, and all four finite nonnegative native cost rates as `cost` (USD
per million tokens), never credentials/options/headers/environment fields.
Missing/incomplete/invalid prices stay absent; known zero rates remain zero.
Variant names come from the model's variant keys; `free` means the `opencode`
provider with zero input cost. Configured `model` becomes the catalog default
only if present among the connected models. `agents.list` uses the same neutral
colour normalization as transcripts and includes configured model/variant
metadata. Native user `info.model.variant` maps to OTK `UserMessage.variant`
(stock 1.18.34).

`usage.getUsage(sessionID)` reads only assistant usage headers from read-only
SQLite in100-row pages, reduced by the public UsageLedger into full session and
user-turn totals, per-model counts/cost, call clocks and exact live-replacement
baselines. Bounded tool projections retain only IDs, original tool names and
existing titles; text, tool inputs and tool output are never read. Live mapping
preserves the same source name alongside the normalized tool kind.
Missing/incompatible database schemas use the existing bounded Messages.scan API
fallback and release each page's content immediately. Zero prices and reported
zero costs remain distinct from absent catalog metadata. The owner counts
reverted-but-charged stored steps too.

Optional native selection metadata may be null. Agent descriptions, configured
models/variants and restored user agent/model/variant values are normalised to
the neutral string/reference-or-absent contract here. Optional session parents,
reply parents and attachment paths follow the same boundary convention; valid
identifiers and empty strings retain their spelling. Consumers never inherit a
native null sentinel. Missing task agent metadata likewise stays absent rather
than implying a built-in agent.

When reconnect loses a streaming seed, point-message recovery coalesces deltas
per subscribed message at a 50 ms cadence, with one in-flight read and a
trailing refresh only when more deltas arrive. Snapshots render only the
requested parts; they never seed appends because the native API has no shared
snapshot/event offset. A native part update restores event-owned streaming.
Unsubscribe, removal, disposal, disconnect and stop cancel the recovery's
timers/readers and suppress stale output.

Message collections have one bounded reader (1–200 messages per page); zero or
missing limits cannot invoke stock's whole-history mode. Revert counts use a
read-only SQL scalar. Task cards stream read-only SQL projections in pages of
100, containing only message times/roles and tool IDs/titles/status/start times.
Missing or incompatible databases use stock API pages of 100, reduced as they
arrive rather than accumulated. Only summary metadata is retained while the
parent is open. Native directory resolution reads the session record without
decorating its revert information. The core's authoritative directory lookup can
still use `getSession`; its revert count follows the same bounded contract.

Public transcript pages use a fixed ten messages, while internal digest/history
scans retain their own bounded limits. The native transcript owner wraps the
exact native continuation in a version/session/epoch/cutoff envelope and rejects
stale or foreign cursors before I/O. Ordinary older pages reuse authoritative
session/directory/cutoff metadata and make no boundary-message or repeated
session GET. Initial viewers share a cancellable session read without sharing a
caller's abort. Rollback, reconnect and body retirement invalidate old page
authority. Pages checkpoint event-owned buffers before sealing their clock and
carry full replacement catchup independently of their historical collection
items. User agent/model/variant metadata is read through the digest worker even
when the latest prompt lies outside the page. Standalone integrations supply
replay policy explicitly and use bounded API pages when no worker is composed.

The public entry also exposes native raw types, mapping utilities, `Client`,
`HttpFailure`, `History`, `BootstrapDb`, SSE/watchdog utilities and
`TaskProgress` for native integrations. Cross-package imports always use this
entry.

The standalone sessions consumer and stock-server test are in `tests/reuse/` at
the workspace root. Run `deno task test:reuse` in the dedicated OTK guest.

### Reusable digest sink

`OpencodeV1DigestSink` is independently composable with a `DigestScheduler` and
an injected `OpencodeV1DigestStorage`. Its private SQLite/query and transaction
ports are supplied by the consumer; this package imports no OTK store. Compose
the structural `opencodeV1DigestMigrations` contribution into the derived file.
The consumer maps neutral `DigestDelta`s to its own persistence/publication
boundary; publication follows commit. The sink's `catalog`, `step`, `detail`,
`invalidate`, `connection`, `deleteIntent` and `close` share that lifetime.

`DigestNativeDb` opens only an existing read-only native file. Its characterized
session/header projections use bounded keysets and `json_each` batches, never
full message/part JSON. Summary scans do not query parts. Opened usage detail
batches existing tool labels. Missing/incompatible SQL falls back to the one
bounded `Messages` reader; unreported usage remains nullable and cannot become a
fictitious free detailed ledger. Private baselines store allowlisted metadata
hashes, contribution sums/unknown counts and sweep progress, not message
content. Provider health and catalog identity samples gate local-file authority;
failed or partial enumeration does not tombstone anything. Reappearance clears
the tombstone under the same qualified identity.

Ownership samples use a bounded current identity lookup, independently of the
older keyset enumeration. A new session behind that cursor cannot falsely turn
the configured file into a foreign-file fallback. Verified continuity belongs to
the unchanged file and native connection; missing sample rows are inconclusive,
while conflicting identities use API authority. Unverified files cannot provide
header metadata or running-directory hints. Catalog admission also fences later
per-identity observations, so an older inventory cannot retire a newer presence
fact or revive a newly retired lifetime.

The OTK application worker composition lives outside this package. Source and
compiled independent-consumer checks exercise it before selection in the shipped
application; the existing standalone adapter needs no derived state directory.

The bounded `emptySessions` native projection proves absence of headers without
reading message or part bodies. The authoritative catalog can commit exact zeros
for new/already-empty sessions together; existing nonempty baselines still use
the normal sweep, and a raced dirty marker prevents an empty proof overtaking an
event. Scan generation/cursor admission commits with its baseline and summary,
including rollback on a rejected write. `DigestNativeDb` accepts an optional
read-observation callback for independently composed counting consumers.

An optional fourth adapter argument injects `DigestPort`. With it, bootstrap
borrows the complete worker catalog/hints, accepted header events enqueue scalar
invalidations before content-demand filtering, and usage detail runs through the
worker. The adapter joins worker shutdown. Without it, standalone consumers keep
the complete bounded API catalog and honest unready index summaries.
`index.days` prioritizes recent background work; it never filters catalog
identity. `deleted(connection,id,revision)` carries accepted native deletion
authority to the sink independently of a new inventory. Tombstones retain
metadata; current generation OTK deletion intents classify matching events, and
native ownership is retired without a synthetic finish. Reappearance reconciles
the same identity.

Accepted deletion events and successful OTK deletions carry allowlisted
last-known session metadata to the worker. It can commit and publish a new
tombstone before background cataloging has persisted that identity; a cold
consumer receives its metadata seed before the digest delta.

Native unit tests live in this package; mixed app-consumer checks retain their
shared app fixtures. Tool mapping retains native output on the common tool
contract. `tool-results.ts` decodes characterized stock 1.18.34 read, directory,
glob/list, grep, skill and task formats once, into harness-neutral user results.
File lines retain native numbering/range and total/truncation metadata; grep
matches carry path/line/text. Model-only wrappers and instruction envelopes
remain in raw provenance, not user content. Unknown or inconsistent formats
retain the complete verbatim fallback. Read/write language inference has one
shared native owner. License: LGPL-3.0-only.
