# @otk/harness-opencode-v1

`records.ts` owns native record classification and content-proven prompt
identity. Synthetic-only or header-only user records are context, never prompt
anchors. Mixed messages retain their prompt and carry each synthetic expansion
as an outgoing part. Snapshot, live projection, worker SQL and API fallback
share this evidence contract. Bookkeeping, compaction, interruption, delegation,
retry and unknown records remain visible with their native source; task result
envelopes share one decoder and render as blocks.

`V1RecordRetention` owns the versioned V1 request/outcome and retry schema.
Application composition injects an isolated `PluginStorage` through
`storage(storage)` before startup; values persist through OTK restarts in the
existing OTK database, never in the native database. Other plugins cannot read
or overwrite this namespace. Standalone adapters without injection retain only
process-local records. Timeline reads are bounded and merge with native pages
without changing native continuation semantics. Active retry status remains
separate from historical retry records and their provider action links. Request
observations from native inventories and live asks share retention; richer raw
asks and terminal outcomes cannot be downgraded by later inventories. Outcome
summaries use the requested tool/target or question header/text, not IDs.

The public `Client` also supports explicit
`classification: read | effect |
stream` and optional neutral `operation`
context. Classified reads require the consumer's `harness.requestms`; there is
no classified library default or caller timeout override. Effects fence
immediately before native I/O, use lifecycle cancellation and classify ambiguous
network/5xx outcomes as unknown. A definite 4xx rejection is separate.
`NativeRequestFailure` exposes neutral certainty and safe semantic failure
facts, retaining the original cause for diagnostics. Optional operation contexts
on mutating capability ports reach that same owner; standalone consumers can
omit them. Scoped shell/command/compact calls join the owned launch's
settlement, while callers without an operation keep their selected admission
contract. `NativeLaunch.admitted` equals settlement when stock HTTP supplies no
earlier reliable admission evidence. Independent native event errors retain
their separate provenance.

Worker composition injects cooperative readiness and native I/O-admission ports
into the digest sink. HTTP permission, response settlement, hashing and bounded
scan yields release the scheduler turn; standalone sinks without a scheduler
await readiness directly. A yielded scan checks connection, deletion and private
checkpoint authority before committing either data or an error. It cannot
overwrite a newer essential read's committed baseline or revive a deleted row.

Stock opencode 1.x implementation of `@otk/harness`. Qualification targets are
1.18.34, 1.18.35 and 1.19.3; intermediate versions are not individually implied.
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
    requestms: 60000,
  },
  index: { days: 30 },
  digest: {
    batch: 100,
    slicems: 8,
    cpu: 0.25,
    memoryreserve: 134217728,
    maxpending: 512,
    publishrows: 64,
    retryms: 1000,
    busyms: 100,
  },
  catalogs: { concurrency: 2, statconcurrency: 8, pending: 128 },
  attachments: { concurrency: 4, maxrefs: 64, maxbytes: 33554432 },
  messages: {
    prefetchms: 300000,
    prefetchbytes: 67108864,
    coolms: 300000,
    preloadms: 30000,
    concurrency: 4,
    replayops: 128,
    replaybytes: 4194304,
    retryms: 1000,
    recoveryconcurrency: 2,
    recoverypending: 128,
  },
});
try {
  await harness.core.start({
    connection: (state) => console.log(state),
    indexReset: (sessions) => console.table(sessions),
    indexUpsert: (session) => console.log(session),
    indexRemove: (id) => console.log("removed", id),
    content: () => {},
    bootstrapComplete: () => {},
    invalidate: () => {},
  });
  // Keep the consumer alive while observing the index stream.
  await new Promise((resolve) => setTimeout(resolve, 5000));
} finally {
  await harness.core.stop();
}
```

Run a consumer with Deno's network/read/environment permissions and
`--allow-sys=systemMemoryInfo` for standalone scheduled catalog admission. No
OTK sidecar is required; start a stock server separately. Empty `db` resolves
through `XDG_DATA_HOME`/`HOME` using the native default. There are no sidecar
auth/state inputs. Optional capabilities are implemented in feature-owned
modules and share one session-directory resolver. Use `core` for
lifecycle/session queries and `capabilities.<name>` for optional operations. The
adapter exposes the same honest optional capability map as `Harness`; consumers
check or `requireCapability` at their operation boundary. Augmenting the open
protocol contract never promises that this stock adapter installs that port.

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
`{providerID, modelID}` through the existing owned request lifetime. An
operation-scoped call joins native HTTP settlement without a failure deadline;
uncertain dispatch remains reconciling under the request owner. Progress and
native event errors retain their ordinary session provenance. Native
summarization joins current work and commits a pending rollback, as the next
prompt does.

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
owned requests and releases readers. History lists contain prompt text and
attachment references, never upload bytes. The shipped facade uses the same
worker/scheduler's transient `history.list`, `history.entries` and
`history.attachments` contributions. No history result enters digest commits or
durable receipts. Missing/incompatible provider databases reject as unavailable;
they are neither created nor represented as a successful empty history.

`History(providerReadPort, attachmentPolicy)` is independently composable.
`History(existingFile, attachmentPolicy)` supplies a standalone read-only owner;
the policy is explicit in either form. `listHistory(signal?)` selects the newest
`PROMPT_HISTORY_LIMIT` global user candidates with bounded descending header
chunks, then deduplicates adjacent equivalent prompts. Parts and synthetic shell
commands use two set queries for the whole batch.
`entry(sessionID, messageID, signal?)` is asynchronous and uses that same batch
mapper. Malformed individual entries are diagnosed and omitted; an unavailable
reader does not erase the failure as an empty result.

`attachments(refs,signal?)` validates the entire unique, ordered batch using one
scalar admission query before a second selected-body query. Results correlate
each `ref` with its upload `part`. Count, combined decoded bytes and the shared
immutable per-upload limit all apply before bytes leave SQLite. Byte-bounded
fragments use the existing publication credits; contiguous offsets and exact
final lengths are checked before exposing an attachment. The compatibility
`attachment(ref,signal?)` delegates to a one-element batch. Protocol 17 uses
`history.attachments`; there is no point-per-item browser wire path. No provider
data is recoverable from an unlinked/replaced native file handle. Missing,
wrong-kind or over-budget attachment references are definite native rejections,
not provider-unavailability waits; the existing safe attachment failure
presenter retains the draft and chips for correction.

Explicit path attachments are required: normal prompts and slash commands
resolve every selected path and check file-read or directory-list access before
native admission. A missing or unreadable path rejects the whole send with an
`attachment` error naming that path, so the caller retains its draft and chips.
The mapper never omits a submitted part. Only best-effort file discovery may
skip unavailable candidates. Normal and slash sends share one bounded per-send
path workset and attachment policy. Paths remain native file references; these
checks do not copy whole file contents or prevent subsequent external filesystem
changes. Bounded headers identify PNG/JPEG/GIF/WebP/PDF, UTF-8 text without NUL,
or unknown binary. A line range requires text. Local `file://` references are
converted with native path semantics (including percent decoding); empty and
localhost authorities are accepted, remote authorities rejected.

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
native instance disposal or stop. Native connection recovery revalidates
demanded directory catalogs once and rebinds active color subscribers; it never
reloads native configuration itself.

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
bootstrap and global permission events. Family list readers and attention counts
derive from that owner, including with no content subscriber; replies remove
entries through the native event. Transcript tools carry no stamped permission
state: their waiting labels borrow the live request list used by the dock.
Activity bootstrap and live pending input acquire their routing identities and
ancestry through the existing keyed hydration port before deriving family
counts. A placeholder cannot establish that a helper has no parent. Readers
receive detached values rather than making another live HTTP inventory request.
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
visit clocks. Scalar candidate discovery uses bounded identity chunks. Missing,
unreadable, incompatible or failed SQLite authority reconciles only previously
observed active directories; it never loads every discovered native instance or
point-reads sessions to obtain activity. Other facts remain explicitly unknown
or stale. One candidate directory at a time borrows attention-priority status,
permission and question reads from the existing worker/read-admission owner.

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
Task links retain only parent/message/part/child identities and revisions.
Parent release, cutoff, epoch retirement and deletion release those links; there
is no child scan or parent point-read lifetime in the serving link owner.
Explicit session deletion releases pending input and direct attention, task and
revert ownership, optional colours, recovery, commands and buffers together.
Error observations are admitted independently of the index window. Empty-state
revisions borrow the authoritative index, or live only with an active
out-of-window subscriber/request. Unsubscribe releases those empty consumer
clocks. Deletion fences last until the next accepted snapshot generation; old
HTTP tokens remain invalid after that barrier. Reconciliation releases unowned
observations rather than retaining busy/cleared keys and old-generation deletion
metadata forever.

`capabilities.models.listModels(sessionID, signal?)` borrows the directory's
connected model catalog. Initial acquisition reads native
`GET /config/providers` and `GET /config`; other sessions share it, with
per-caller cancellation and last-demand cancellation of acquisition. It
allowlists connected provider and model display metadata, including finite
positive native `limit.context` as `contextLimit`, and all four finite
nonnegative native cost rates as `cost` (USD per million tokens), never
credentials/options/headers/environment fields. Missing/incomplete/invalid
prices stay absent; known zero rates remain zero. Variant names come from the
model's variant keys. `free` is true only when every applicable reported rate is
known zero, false when a known rate is positive, and null for unreported
pricing, independently of provider identity. Configured `model` becomes the
catalog default only if present among the connected models. `agents.list` uses
the same neutral colour normalization as transcripts and includes configured
model/variant metadata; its optional read signal also reaches native `/agent`
acquisition. Native user `info.model.variant` maps to OTK `UserMessage.variant`
(stock 1.18.34). Session/composer discovery fetches only connected metadata. A
future Connect provider flow must acquire the all-provider `/provider` inventory
on demand, rather than prefetch it during ordinary session navigation.

`usage.getUsage(sessionID,turnID,signal?)` reads only that turn's assistant
usage headers and existing tool labels. The shipped worker queries indexed
private scalar baselines by session/turn, with native labels batched for each
bounded header chunk. An explicit unready detail finishes scalar digestion under
its interactive read slot. The adapter captures the content clock before
acquisition. Snapshots and live mapping share nullable reported-value
validation, so missing or invalid categories cannot become a fictitious zero
charge. Standalone read-only SQLite targets the same turn; bounded API fallback
releases pages as it extracts matching call metadata. No text, inputs or output
leave detail. Missing/incompatible database schemas use the existing bounded
Messages.scan API fallback and release each page's content immediately. Zero
prices and reported zero costs remain distinct from absent catalog metadata. The
owner counts reverted-but-charged stored steps too.

Optional native selection metadata may be null. Agent descriptions, configured
models/variants and restored user agent/model/variant values are normalised to
the neutral string/reference-or-absent contract here. Optional session parents,
reply parents and attachment paths follow the same boundary convention; valid
identifiers and empty strings retain their spelling. Consumers never inherit a
native null sentinel. Missing task agent metadata likewise stays absent rather
than implying a built-in agent.

Successful live plan approval borrows the native synthetic user message's agent,
correlated with the native completed result and its time range, for a neutral
`ToolBase.selectionIntent`. A tool name alone is never selection authority.
Historical mapping has no access to that live owner; disconnect, release, revert
and deletion retire its facts. Missing search pattern/count, diff path/status
and todo priority stay unknown; complete decoded search results may prove an
exact count, while truncated results without a native total cannot. A real file
named `unknown` remains literal. `NATIVE_SCAN_ROWS` owns bounded Messages/fork
scans and `REVERT_PROMPT_LIMIT` owns SQL and fallback rollback preview
retention.

When reconnect loses a streaming seed, one generation per subscribed message
queues one replacement-only point checkpoint. Further deltas retain only missing
part identities and never rearm HTTP reads. Adapter-wide `recoveryconcurrency`
bounds reads; `recoverypending` bounds fine keys, including terminal barriers,
before replacing them with a source-free scoped reconciliation marker. The next
page and terminal checkpoint reconcile that scope through the same transcript
owner. Finite deadlines belong to Client, with no recovery polling timer or
second timeout.

HTTP results publish a header before requested parts, share the stream owner's
generation clock, and never seed appends or fabricate output receipt clocks. The
browser shows “Refreshing response…” until a full native part event or a
terminal checkpoint supplies authority. Failed checkpoints expose unavailable
state and explicit Retry response; a distinct authoritative header can retry,
but deltas cannot. Unsubscribe, cutoff, epoch retirement, removal, disposal,
disconnect and stop cancel readers and fence late results. A full part event
restores event-owned streaming with a strictly newer generation.

Transport retirement suspends parser publication timers while retaining its
last-good native event source. Reconnect rebinds those retained parsers to the
new content epoch, allowing subsequent live chunks to append without replacing
the prefix with a shorter unfinished HTTP value. Known instance disposal,
deletion, cutoff, terminal authority and stop still retire raw source. HTTP
checkpoints remain replacement-only and carry scalar source coverage. Retained
parsers remain explicitly recovering until full native part authority or a
terminal checkpoint reconciles continuity. A terminal header alone cannot
certify retained bytes; the existing bounded recovery owner joins the complete
native checkpoint before publishing final source.

Recovery admission follows active body leases. Unwatched retained parsers remain
source-only until reacquisition restores their reconciliation lifetime.

Message collections have one bounded reader (1–200 messages per page); zero or
missing limits cannot invoke stock's whole-history mode. Revert counts use a
read-only SQL scalar. Helper progress uses the worker-owned digest described
below, independently of parent pages. Native directory resolution reads the
session record without decorating its revert information. The core's
authoritative identity validation uses `core.identities`, not `getSession`. It
returns only qualified identity, directory and optional parent. The selected
worker uses bounded `json_each` batches against native `parent_id`, after
current provider reachability and file-ownership checks.
Missing/foreign/incompatible files use serial raw session GETs with normal
admission and no revert, body, usage or Markdown work.
`Directory.cached`/`resolve` remain routing hints; `validate` is always a fresh
authoritative read. Unreachable providers remain unavailable, never
authoritative absence.

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

After a demanded page, the same transcript owner queues only its next older
native page through the existing idle-gated provider-read scheduler. One
adapter-wide memory-only FIFO cache holds raw bodies plus scalar transcript
metadata, charged by complete encoded key/payload bytes. `messages.prefetchms`
expires entries from insertion and `messages.prefetchbytes` bounds their total;
oversized entries are not retained. Hits skip both body and metadata source
reads and seal fresh replay clocks. Mutation, metadata replacement, cutoff,
epoch retirement, source reset and stop retire cached/in-flight authority.

Pages and turn detail also carry an ordered `{generation, revision}` version.
When a caller supplies the page-publication port, a complete clocked body page
is sealed and published before scalar metadata acquisition. Its final response
updates prompt/turn coverage under the same producer authority, without reading
those bodies again. Standalone callers retain their single coordinated result.
Actual reconnect/disposal and revert-boundary changes retire producer authority
and emit `transcript.invalidated` at that boundary. Metadata bootstrap
completion has its own `bootstrap.complete` event and does not retire pages
acquired during bootstrap. Demand release still renews the opaque content epoch;
it does not pretend that the provider changed. Already-current consumers can
ignore a delayed or duplicate invalidation at the same version.

The public entry also exposes native raw types, mapping utilities, `Client`,
`HttpFailure`, `History`, `BootstrapDb`, SSE/watchdog utilities and
`TaskProgress` for native integrations. Cross-package imports always use this
entry.

`TaskProgress` is a synchronous link/decorate owner with injected summary peek,
priority-hint, subscription and narrow content-publication ports. It accepts no
native reader and has no polling timer. Shipped progress comes from the existing
worker's native digest feature v2: bounded set-oriented helper-tool projections,
scalar private baselines/generations, authoritative stale-row sweep and atomic
neutral helper publication. API fallback extracts the same scalar fields one
bounded page at a time. Ordinary usage/header jobs project only scalar clocks,
never part bodies. Helpers discovered outside OTK and explicit task references
follow the same path. Without an injected digest, standalone adapters publish
unavailable progress immediately rather than privately scan child history.
`TaskCall` exposes `progress` instead of `currentTool`/`toolCount`;
helper-derived time never rewrites its native completion clock.
`requestHelper(id, changed)` owns provider-private hint admission and
`invalidateHelper(id)` marks an authoritative sweep dirty. The worker
composition does not inspect the sink's private checkpoint tables. After
backfill, SQL helper jobs reconcile only the changed message identities,
including authoritative tool removals; priority-only hints preserve those keys.
Lost fine-grained keys fall back to a complete bounded generation, and API
fallback continues through bounded native collection pages.

The standalone sessions consumer and stock-server test are in `tests/reuse/` at
the workspace root. Run `deno task test:reuse` in the dedicated OTK guest.

### Directory catalog services

`adapter.catalogs` is a public `DirectoryCatalogs` service. `acquire(directory)`
returns a borrowed lease with `get(kind)`, `snapshot()`, `subscribe(listener)`,
`refresh()` and idempotent `release()`. Agents, commands, skills, connected
models, resources and complete files share one acquisition per demanded
directory/kind generation. Compatibility capability methods borrow these same
values across session visits; primary/mention/color views share `/agent`. The
native agent `color` survives mapping and transient publication. Color
decoration borrows the shared last-complete value during refresh; preparing a
replacement cannot erase an already reported color. Hidden agents retain color
metadata while both selection flags stay false. An unresolved directory does not
trigger a default-directory color acquisition. Commands merge shared command and
skill inventories without exposing their bodies. Catalog acquisition never
copies credentials or file content.

Configuration catalogs reflect **what the native instance reports**. External
configuration edits do not force a reload. Native lifecycle/catalog events
invalidate current demand; OTK never disposes an instance to refresh metadata
and never installs configuration-file watches. The file catalog alone watches
its opened project tree. It walks typed `/file` children, honors the endpoint's
reported ignore semantics, excludes `.git` entries even when native reports them
as unignored, normalizes directory identities and never treats the capped
`/find/file` search as a complete inventory. Changed parents reconcile without
rereading unchanged subtrees. A failed subtree retains the last-good complete
value as unavailable. Explicit prompt references still validate through the
attachment owner independently of ordinary discovery.

The last file-demand lease closes the file watcher and releases its complete
file value even when an agent/color borrower retains the directory. Final
directory lease release aborts volatile work and releases complete values.
Native generation changes fence late results while preserving live leases.
`stop()` joins retirement. `PendingQuestions` holds full normalized pending
requests with their asking directory/generation independently of browser demand;
event updates precede publication, inventory capture cannot resurrect a replied
request, and answers validate current constraints without a fresh inventory read
while continuity is known.

Shipped acquisition uses the existing digest worker's transient provider-read
contributions and bounded publication credits. These values never enter digest
commits or request receipts. Standalone adapters use `CatalogExecutor` with the
same `DigestScheduler`, explicit `digest`/`catalogs` policy and no OTK database.
An independent consumer can inject a `ProviderReadPort` into
`DirectoryCatalogs`, plus feature-owned `contributions`; external kinds need no
machinery edit. Application policy comes from the complete defaults. Catalog
wire leases are exposed by
`capabilities.catalogs.watch(directory,listener,signal)`,
`demand(directory,{kinds,intent},signal?)` and
`refresh(directory,signal?,kinds?)`. Watching is passive; per-kind warm and
consumer intents use the same acquisition owner at background and user priority.
File demand borrows the subscription lifetime; the last subscription releases
its file tree/watch even if a standalone choice borrower remains. Pending user
requests keep their independent attention authority. Compatibility methods still
borrow the same acquisition owner.

### Reusable digest sink

Unfinished native text/reasoning uses `mapStreamingShell` for identity/time
metadata and the event-owned parser checkpoint for its blocks. Active page parts
borrow that checkpoint before mapping HTTP source. Recovery headers and optional
completion clocks do not map or parse discarded bodies. Ordered events publish
terminal headers immediately; an optional `message.clock` transient read refines
only last-output time, using worker-native scalar SQL or scalar extraction from
the existing point-read fallback. It shares the selected scheduler, connection,
admission and publication credits and never becomes digest data. Per-message
revision, epoch, subscription, deletion and connection fences retire late
results. Fine pending keys use the existing configured recovery capacity with
source-free scoped reconciliation on overflow. Revert cutoffs remain synchronous
authority while optional boundary presentation resolves independently at visible
priority. `History.entry` accepts an optional read priority after its signal;
explicit recall and action reads retain user priority.

`OpencodeV1DigestSink` is independently composable with a `DigestScheduler` and
an injected `OpencodeV1DigestStorage`. Its private SQLite/query and transaction
ports are supplied by the consumer; this package imports no OTK store. Compose
the structural `opencodeV1DigestMigrations` contribution into the derived file.
The consumer maps neutral `DigestDelta`s to its own persistence/publication
boundary; publication follows commit. The sink's `catalog`, `step`, `detail`,
`invalidate`, `connection`, `deleteIntent` and `close` share that lifetime.

Private checkpoint v2 records source mode/generation, descending native
`(time_created,id)` position, a separate API cursor, observed revision and
inclusive requested/covered boundaries. Migration 003 restarts old ascending
checkpoints without deleting baselines or totals. Partial coverage never sweeps
stale rows or declares global readiness. Source exhaustion does both atomically;
raced dirty replacements require another authoritative sweep. Helpers own their
independent, source-fenced projection cursor rather than finishing all headers.
Pending turn identities survive bounded reconciliation and stale sweeping.
Previously committed turn and session results are retained until a coherent
replacement is covered; terminal finish/error evidence and complete call
membership are both required for finality. Latest context ignores unreported
calls but accepts reported zero. Helper count/current/time stay together through
refresh and source outage. Repeated unchanged project-policy input does not
restart discovery or helper backfill.

`DigestNativeDb` opens only an existing read-only native file. Its characterized
session/header projections use bounded keysets and `json_each` batches, never
full message/part JSON. Turn timing adds scalar text/reasoning/tool clock
projections to each admitted header, separating model output from tool
settlement before the shared accumulator computes working time. Recorded
question lifetimes are waits. Missing terminal endpoints remain unknown, never
streaming. A retained retry without a resumed request clock is incomplete
evidence, not a measured retry pause. Page, live and recovery paths consume the
same native closure fact even without a completion clock. A covered terminal
turn closes its calls without filling missing endpoints from a later call.
Opened usage detail batches existing tool labels. Missing/incompatible SQL falls
back to the one bounded `Messages` reader; unreported usage remains nullable and
cannot become a fictitious free detailed ledger. Private baselines store
allowlisted metadata hashes, contribution sums/unknown counts and sweep
progress, not message content. Provider health and catalog identity samples gate
local-file authority; failed or partial enumeration does not tombstone anything.
Reappearance clears the tombstone under the same qualified identity.

Ownership samples use a bounded current identity lookup, independently of the
older keyset enumeration. A new session behind that cursor cannot falsely turn
the configured file into a foreign-file fallback. Verified continuity belongs to
the unchanged file and native connection; missing sample rows are inconclusive,
while conflicting identities use API authority. Unverified files cannot provide
header metadata or running-directory hints. Catalog admission also fences later
per-identity observations, so an older inventory cannot retire a newer presence
fact or revive a newly retired lifetime.

Catalog reconciliation commits bounded identity batches and yields between them,
rechecking its connection fence on continuation. Per-identity neutral/private
writes stay transactional, and inventory completion is recorded after the full
reconciliation. Concurrent callers share the owning catalog lifetime rather than
interleave sweeps. A joining caller requires an enumeration admitted after its
observations; an older in-flight catalog cannot satisfy newer invalidations.
Worker inventory demand remains outstanding until admission completes, so all
dependent session steps join it and completion acknowledges only its captured
revision. Worker admission batches summary lookups and yields through the same
priority executor instead of scanning the complete catalog synchronously.

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
