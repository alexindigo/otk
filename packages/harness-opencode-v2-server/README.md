# @otk/harness-opencode-v2-server

Local, read-only discovery of the stock opencode V2 background service. The
Promise client is pinned to 2.2.6. This package never starts/stops the service,
signals its process, or writes its database. Native session IDs use `opcv2-`.

`discoverV2(file)` preserves missing, unreadable/malformed, stale identity,
unreachable, incompatible JSON and authentication failures before calling
`Service.discover`. The user's managed registration owns the URL: probes,
identity checks, adapter clients/streams and worker re-discovery use it
verbatim, without hostname restrictions or rewriting. Headers come from
`Service.headers` (UTF-8 Basic auth). The application resolves HOME/XDG paths
and selects auto/V1/V2; credentials never enter neutral protocol frames or
browser config.

`V2Client.read` owns finite reads, cancellation and error classification. The
SDK stays private. Native not-found tags establish absence; transport, timeout
and malformed responses remain unavailable. Per-read async context carries
caller cancellation through concurrent SDK calls, and aborted continuations
cannot return late data. `effect` fences each native exchange immediately before
I/O, has no finite mutation deadline, and retains ambiguous outcomes as unknown.
`sequence` serializes a whole same-session operation, including preparation,
selection checkpoints and final settlement. Disconnect aborts and joins effects.
The client distinguishes a retired stream generation from explicit lifetime or
caller cancellation. Generation loss makes finite reads and undispatched work
unavailable; a dispatched mutation whose result was lost stays unknown. Raw body
read errors remain diagnostic causes, never untyped request outcomes or retry
permission for mutations.

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
Shell completion instead joins the shell exchange itself, never execution.wait.

Native command HTTP diagnostics and execution failure/interruption events share
the neutral SessionErrors owner with V1. Query, page and live publications carry
the same revision and provenance; independent HTTP and event observations remain
distinct. HTTP status/ref survive SDK decoding without changing effect
certainty.

Location-scoped shells are independent of native session executions. Their
scalar inventory and start/end events contribute busy state without transcript
subscribers, including after reconnect. Interrupt bypasses the effect sequence
and stops both the execution and that session's shells, retaining original
locations for moved sessions and leaving unrelated shells alone.

`V2Prompt` prepares all attachments before selection changes, serializes each
session's sequence, and calls separate agent/model switches only when their
explicit native selections differ. Variant changes use the model switch.
Successful intermediate changes checkpoint selection metadata, never prompt or
attachment bytes. The final prompt retains exact text, mention offsets and
resolved recall bytes. Interrupt bypasses that queue and omits `resume`;
`interrupted:false` is idle success.

`V2Pending` is the canonical volatile permission/form owner. Permission replies
use the asking session and native `decision`; rejection includes feedback. OTK's
existing server-owned policy supplies automatic `once` replies, without native
rule rewriting. Typed forms preserve string/number/integer/boolean, multiselect
and external-step values. Only question-tagged `qN` string/choice forms
additionally project the legacy question API. Both use one retained client
form-state owner and choice renderer; attention counts each form once. Global
forms retain a location owner, use the directory header on native replies, and
appear through registered global surfaces with project attention. They never
acquire a fabricated qualified session ID. Explicit settlement events retire
pending requests even when another inventory is unavailable.

Permission-not-found/already-settled tags and definite permission HTTP 404s
retire the same pending identity as settled elsewhere. A later reply is a no-op
only for a confirmed settlement. If no route is available and settlement is
unproven, the reply fails without dispatch. Settlement barriers last for the
pending owner's lifetime; stale inventories and events cannot resurrect them
after a fixed number of newer settlements.

Each successful kind/location inventory owns only its own absence facts. Failed
inventories retain known unresolved identities and payloads for still-loaded
directories but stale identities never drive needs-you. Failures publish safe
background-error feedback independently of session errors. A successful
inventory or reconnect seeding restores fresh pending keys only for
still-pending requests. A complete loaded-location inventory removes dropped
directories from both projections and capability payloads, including global
forms, without settlement tombstones. Reappearing locations may therefore report
the same unresolved IDs. Explicit settlement and successful empty kind
inventories retain their existing replay barriers. Metadata-read failure cannot
prevent an already-known session's request projection from converging.

`V2Stream` owns one subscribed SSE generation. It waits for `server.connected`
before snapshot reads, stages events under the injected operation/byte budgets,
deduplicates durable positions and IDs, and pauses its 45-second byte watchdog
only for owned parser backpressure. Reconnect re-discovers credentials and
resyncs before readiness. Snapshot acquisition returns a fenced commit; abort
joins acquisition and event work before closing. Execution facts survive
decodable frames whose unrelated fields drift. The SDK event queue is unused.

The parser feeds one ordered dispatcher under the existing replay operation/byte
budgets, so backlog is counted rather than hidden in transport buffering. One
parser frame and one next-chunk read can wait outside that queue. Native order,
including each session's ephemeral settlements and durable watermarks, is kept.
Body cancellation joins both the owned read and dispatcher before releasing its
lock. Dispatch diagnostics report received/handled counts, queued bytes/events,
oldest age, native creation-to-handling lag, active type and handler time; the
application's existing diagnostic sink records these every ten seconds.
Execution-failure facts and anchor reads borrow that generation's signal as well
as transcript lifetime, so teardown cannot wait on a read whose cancellation was
dropped. Ordinary source failures still retain their diagnostic and failure
record; cancellation does not become a new failure.

The adapter composes scalar connection/index facts with qualified catalog
capabilities. The worker's `core/digest/providers.ts` selects native codecs,
private migrations and sink construction without changing scheduling or SQLite
ownership. Its V2 sink proves all API project IDs/canonicals (including archived
projects) against the read-only file before scalar SQL. Schema/source failures
fall back to point/list APIs; project counts and recency remain explicitly
unknown. Startup publishes grouped population facts, never an idle session/body
catalog. Keyed hydration follows helper ancestry, independently of transcript
subscriptions. Active executions and loaded-location pending inventories keep
lamps live.

Permission/form events update only their own pending identity and ancestor
attention deltas, never re-read every location or active family. Pending counts
and running shells have keyed indexes; the shared metadata index's topology
observations keep attention coherent when another producer learns a parent.
Metadata, project and topology-inventory refreshes coalesce by key outside event
dispatch. Obsolete reads cannot publish over a newer request or deletion; an
inventory cannot retire/stale requests delivered during its acquisition. Native
metadata events use scalar session facts and observed activity clocks rather
than scanning message bodies for recency. Missing shell identities use one
demand-owned, cancellable lookup outside dispatch, releasing each bounded page.
Refresh failures retire the stream generation for canonical resync, and refresh
queue pressure accompanies the dispatch diagnostics.

After requested work drains, the shared scheduler can discover scalar sessions
in Active projects through bounded newest-first SQL keysets or native API
cursors. Project-policy and connection changes fence those cursors. This is not
a startup population catalog, another scheduler or a message-body scan.

Project seeds join the saved project and worktree inventories in that worker.
Saved worktrees use bounded scalar pages from the same source-proven native
connection where compatible, avoiding one HTTP read per unseen project. Missing
worktree schema retains the native API fallback. Native project identity bounds
longest-checkout-root matching; exact session directories stay list/task scopes.
Empty inventory roots are not invented populated projects. Failed inventory
omits topology (retaining known facts); complete retirement sends null. With
unavailable SQL, topology remains usable while population/count/recency stay
unknown. This producer uses V6a's neutral `ProjectTopology` shape;
hierarchy/policy consumers belong to that item.

Session lists retain the neutral 20/default, 200/maximum page contract. SQL
keysets use `(time_updated,id)`; native API cursors are opaque. Continuations
bind scope, generation and source mode. Consumed pages join worker demand; only
one successor may be speculated through existing idle-gated admission. Children
use paginated `parentID` filtering, not fork provenance or a `/children` route.
The foundation connection owner composes staged capabilities. Catalogs are
selected when explicit `digest` and `catalogs` policies are supplied. The
application worker port can be injected as the fifth constructor argument;
standalone API integrations use the same neutral scheduler and read-admission
owners. No history database is opened in the serving isolate.

`V2Catalogs` borrows the shared `DirectoryCatalogs` owner. Per-kind
warm/consumer demand is independent of passive subscriptions; warm reads yield
at background priority without an optional idle delay. Files and MCP kinds are
not acquired by watching. Model/agent/command/skill warm-up is selected by the
current-folder client composition, not by the adapter's kind inventory. Agents
retain separate native IDs and display names; commands use unknown provenance
when native does not report it, and skill commands retain their skill IDs.
`listCommands` is a reader for action composition, not an advertisement of
command execution. Model catalogs retain every price tier, provider
availability, variants, configuration provenance and the applied/configured
default distinction. Only an untiered rate supplies the legacy singular price.
Configuration output is an allowlist of discovery paths/order and selection
metadata, never document bodies, settings or credentials.

MCP resources and templates remain separate catalog kinds. The `resources`
attachment capability is deliberately absent on V2: stock V2 has no public
resource-to-prompt materialization route. Picker choices follow capability
advertisement, not the mere presence of resource metadata.

Complete files traverse typed `fs.list` children, not capped ranked `fs.find`
results. `.git` is pruned and physical directory identities prevent cycles.
Stock V2 listings have no ignored flag. The existing file reader filters bounded
groups through read-only `git check-ignore --stdin -z --no-index`, honoring
nested rules, exceptions and repository/global excludes without a pattern parser
or a second catalog. Runtime permission is restricted to `--allow-run=git`;
missing Git or a failed query makes that catalog unavailable. Cancellation joins
the owned query. Outside a Git repository, the listing remains usable. Only
demanded file catalogs open project filesystem watches. Native catalog events
refresh demanded kinds without reloading configuration or booting idle
locations.

`catalogReaders` and `catalogReadCodecs` are worker contributions.
`HistoryReader(database, attachmentPolicy, yieldTurn)` borrows the worker's
existing source-proven read-only connection; it never opens one. Compose its
`readers()` beside the catalog contributions and select the neutral history
codecs. The injected worker port enables `ProviderHistory` on the adapter.
Recall is on intent only, across native user/shell messages, with selected file
metadata but no upload bytes. Stable `file:<index>` references resolve admitted
inline/blob bytes, never original paths. The entire requested batch passes
count/ownership/byte admission before any selected bytes leave SQLite; point
retrieval delegates to the batch operation. Malformed individual entries cannot
erase healthy recall, while incompatible sources remain unavailable, not empty.

The transcript owner maps all native message kinds through one snapshot/tool
mapper. Native controls update selection, not fabricated prompts. Source
sequence orders fork copies independently of their copied timestamps and
non-sortable IDs; synthetic/system/skill/shell/compaction rows never become
real-prompt anchors. Text and reasoning identities count their own ordinals;
tools use call IDs.

`classify.ts` totally maps persisted records, including unknown future tags.
Standalone context is never prompt prose. `eventMessage` mirrors the stock
message updater before calling that classifier: instruction deltas reconstruct
their description/metadata; synthetic and skill metadata survive. A textless
initial instruction observation has no native message and creates none here. The
V2 plugin owns all result-state wording and nullable settlement facts. Switch,
move, idle and compaction records use the same classifier on native pages and
live delivery. Compaction keeps one native identity through its
queued/running/terminal lifecycle; terminal-only records invent no start.
Request usage labels (input plus caches, output plus reasoning) belong here, not
in shared UI. Summaries declare content for Copy; lifecycle bookkeeping does
not. Active retry is an assistant-owned record distinct from the retained
scheduled attempt; its cause also supplies the existing countdown surface.
Delivered retry and future session lifecycle observations reuse the plugin's
durable observation indexes, bounded page merge, revert and deletion lifetime.
Their native source is loaded only through the plugin's opaque source reference.
Native shutdown is continuity loss, never an invented idle success.

Acquired transcripts independently compare a keyed native-head witness (ID,
sequence and update time) at the existing recovery cadence. A changed witness
repairs the checkpoint and its native forward suffix in bounded pages, through
the same classifier; stream upserts alone never certify that interval. In-place
content replacements reacquire their native identity. Unknown/unmapped changes
request canonical repair, and stream handler/decoding failures reconnect and
resync instead of logging a dropped fact. These checks borrow the credited
worker read channel, acquire no unviewed histories and stop/join with the
transcript subscription. Only scalar coverage is retained, never a second body
cache.

Fine recovery owns its keyed point checkpoints, including unavailable reads;
history observation cannot silently retry or replace that ownership. An initial
held page accumulates repair hints until its boundary settles instead of
invalidating its own acquisition. HTTP content never consumes a later native
append start; only an event-owned stream buffer does. The existing compaction
owner likewise retains live summary prefixes and terminal lifecycle against
older unfinished native checkpoints.

`delivery.ts` recognizes only materialized synthetic subagent reports and
completed foreground calls whose result metadata is completed. Background
launches, enqueue and job removal do not qualify. Native parent/child identity,
terminal history and invocation clocks fence correlation; a synthetic with
multiple possible child runs stays unacknowledged. Bounded message/part keysets
project scalars for the worker's private delivery index, including split and
legacy-inline calls. Source/revision-fenced cursors resume after restart; cached
replay does not scan parent history. No receipt body is retained.

Recognized subagent envelopes are removed only by exact metadata-derived
prefix/suffix matching; malformed source remains inspectable. Foreground
delegation renders Markdown blocks, while shell output remains literal. Optional
child relationships share the native codec's non-throwing projection: malformed
metadata cannot invalidate a complete tool or synthetic record. Its exact source
and raw relationship parameter remain available without a link; mandatory
session identities still reject invalid inputs.

Typed messages, parts and calls retain source alongside their projections. Text
payloads remain exact; structured source uses stable JSON with a bounded UTF-8
preview, byte count and truncation fact. Ordered tool-result items keep text,
file names, MIME and media references together. Result failure is independent of
lifecycle: completed execute/shell calls retain completed status and also supply
failure cause; execute's nested operations keep their order.

`V2RequestRetention` owns durable permission/form observations and outcomes in
the injected plugin storage namespace. Its private versioned schema and indexes
are opaque to core. Application composition binds the existing OTK SQLite owner
before the adapter starts; standalone adapters can stage records until binding.
Closing the adapter does not delete durable records. Session deletion removes
only that session's V2 records. Snapshot acquisition merges at most eleven
retained candidates with a ten-message native page and carries exact
continuation through replay capture. SQL-backed histories use native durable
sequence, not copied clocks; the API fallback uses the existing clock-based
source authority. Requests remain context records, never prompts or duplicated
tool outcomes.

`request-failure.ts` supplies plugin-owned failure records for rejected submits
and asynchronous execution failures, using the same retention and FP1 public
failure owner. Execution records retain the exact native turn association
through the existing scalar transcript facts reader; no assistant is required.
Native message/config-path/model-suggestion/status facts pass through the
credential filter before publication or storage, never raw response/config
bodies. Drafts remain owned by the composer when submit rejects. Unknown
outcomes retain their existing reconciliation semantics, without a fabricated
retry action.

Successful native idle records declare neutral footer completion placement.
Failed and interrupted outcomes do not. The canonical client interval retains
their source and inspection paths without decoding native outcome words.

The retained failure supplies a neutral record reference, so FP1 presents its
facts only at that record and projects other feedback as a short reference.
Execution association resolves before the first retained publication. Unanchored
failures borrow the existing sequence/clock position owner at the session tail,
not a session-header presentation. Stock 2.2.6's asynchronous
ModelUnavailableError does not supply suggestions; source-backed rejection
envelopes that supply them retain them.

Failed native idle rows materialize that same retained execution failure during
snapshot acquisition, even before the SSE observer reaches the event. Snapshot
and live routes join by native identity, preserving the first retained facts and
position. The native failed-idle activity is not projected alongside its
retained failure: both routes expose one record. Selection may fail before
promotion, so the scalar facts owner uses the native inbox's enqueue sequence
and delivery priority to identify the pending input. Retention preserves that
association after input retirement; a persisted native event journal can also
reconstruct historical pending inputs. Stock V2 leaves that journal empty by
default. Reply placement honors the causal prompt without moving preceding
native controls. A snapshot needs no second read to recover the failure.

Read-only archive pages share that normalized failure construction without
writing retention or announcing live content. Their bounded native/retained
merge keeps one identity, preferring an existing retained failure's facts and
position.

Recovered failure context can fill a missing origin and causal parent without
changing its record identity, Source or proven position. Archive construction
does not persist or announce enrichment; live materialization does, including
diagnostic-bound enrichment of an existing error observation. Current origins
and retired observations cannot be reassigned or recreated.

Live pages use that same normalized failure row before deriving continuation
edges, so a full page of failed idles advances without replaying retained rows.
Historical pending-input reconstruction prefers the journal at the requested
boundary. An empty stock journal permits current-inbox fallback only at the
current native edge; later inbox state cannot rewrite an older failure. SQL
continuations keep native/anchored sequence and unanchored clock acquisition in
separate domains. The clock scan carries its own physical edge, exhaustion fact
and at most ten unconsumed request identities. One ten-row batch is fetched only
after the prior batch drains; reused native pages rehydrate only that bounded
identity set. Nonprefix presentation selection removes exact qualified
identities, never a clock prefix guessed from a selected sequence winner.
Clock-only interpolation remains presentation, never native sequence evidence.
API fallback continues using its physical timeline index.

The private cursor version binds to session, epoch, cutoff, source and retained
placement revision. Replacing an existing record's physical index keys advances
that revision atomically in the same plugin namespace, including
reclassification and retirement. Body-only updates, new records and unchanged
evidence do not. This fences both outstanding and in-flight captures without
retaining history or adding native reads. Revision survives reopen alongside
indexed records. Cursor validation retains the neutral length bound and rejects
bodies, duplicate or oversized pending sets and sequence data in clock-only
edges.

Settlements are ephemeral native events without a sequence, so each stored
outcome carries a plugin position `{after, rank, basis}`: the session
aggregate's last durable sequence delivered before it, and its delivery rank
inside that gap. A per-connection watermark gives `after` directly; without one,
the first later durable event of that session proves it (`seq - 1`), and until
then one keyed `max(seq)` probe through the worker channel bounds it. With no
sequence evidence the record is placed by its native clock. The projected order
`after + rank/(rank+1)` lies strictly between native sequences. Pages honour the
staged revert cutoff; a committed revert retires observations at or after its
boundary, matching native message and inbox deletion.

Assistant causal context belongs to that same transcript owner. Explicit native
message parent metadata, accepted scalar message context and the native open
prompt admit a step into its turn. Scalar prompt facts are accepted before page
replay: an early live header without replyTo cannot overwrite that proven
context in the snapshot or catchup and create another reply/usage footer.
Historical per-message context does not borrow a newer prompt, and no UI
inference or extra body read supplies the association.

Explicit native-parent provenance stays with baseline/live message context and
outranks later scalar prompt fallback through page, archive and live replay.
Recovering Source reads preserve a longer exact native checkpoint rather than
substituting a shorter retained prefix; terminal native source remains
authority.

`tool-interpretation.ts` owns current and migrated tool aliases, argument and
result dialects. Snapshot/recovery mapping, live tools, usage labels and helper
progress share it; `sourceName` stays native. SQL requests only its declared,
bounded scalar fields and never tool input/output bodies for helper summaries.

Turn timing supplies native streamed model intervals and scalar tool clocks to
the shared accumulator. Bounded header batches project clocks, never tool
bodies. Retained legacy identity/model/creation/update evidence identifies
substituted migration completions in the existing source-proven read-only SQL
owner. Those endpoints are not working-time evidence: the result says Time
unknown and carries the migration explanation. A resumed V2 streamed edge uses
its current evidence, never an old completion. Terminality is independent of
endpoint availability. Header, tool-clock and migration evidence share one
native SQL snapshot. Page, live and recovery owners preserve closure without
inventing an endpoint; replay barriers keep a distinct optional clock and permit
only a fresh start to reopen.

History pages contain at most ten native/retained rows, current queued items,
and optional session notices through FP1. The inbox reader distinguishes an
available empty list from an unsupported route (404/405/501), remembering
absence for that endpoint generation. Unsupported queues cannot reject
transcript acquisition or trigger recovery reads; Source reports its own
unavailable read. Transport, authentication and missing-session failures retain
their existing classification. Reconnect replaces the endpoint generation and
can discover new support. The notice supplies action, captured session target
and reason without inventing retry advice or changing session error/supervision
state. FP1 classifies missing queued-message support as an informational notice,
without failed-action wording or an action to take.

History pages also contain session metadata, real-prompt/reply context and an
event-aligned replay clock. Cursor continuations omit native `order` and bind to
session, epoch, cutoff and source identity. Reconnect stages demanded
running-turn backfill and checkpoints retained streams before new deltas.
Missing seeds use bounded replacement-only recovery; HTTP snapshots never become
append seeds. Unsubscribe, cutoff, reconnect and stop fence late pages,
recoveries, shell output and speculation. Already acquired in-flight append
source survives viewer replacement until its native terminal edge, as in V1.
Retention acquires no unviewed body or recovery read and does not retain
completed transcripts.

`OpencodeV2TranscriptDigestSink` is the transcript contribution composed by the
selected `OpencodeV2DigestSink`. It borrows that scheduler, credited read
channel, derived SQLite owner and the index owner's source-proven read-only
native connection. Background headers exclude text, tool inputs and output.
Private header and pending-turn staging retain published results until covered
replacement and stale-row retirement finish. Turn publication is bounded too;
only a covered native idle boundary can finalize a turn. Latest context selects
the last reported call, including reported zero. Complete scans are idempotent:
unchanged admission performs no digest commit, while known changed message keys
use bounded replacements instead of restarting history. Selected replacement
requires a SQL identity-set read; API fallback restarts the bounded full sweep
without treating an ordinary page as that set. Changed idle and prompt
boundaries invalidate their preceding turn on both sides of a replacement. All
selected batches settle before affected finality is published. Connection
admission fences late page results independently of source/scan/deletion checks.
Full invalidation and source replacement retain the authoritative bounded sweep
path. Helper refresh and source outage retain the coherent count/current/time
result independently of refresh state. Helper summaries use SQL count/current
aggregates, at most one scalar row per admitted message, never the on-intent
tool-detail reader or body API pages. Viewer-acquired parent/helper links
separately borrow the transient `opcv2.helper.progress` read channel. Its
cancellable, bounded pages may use the API when SQL is unavailable; only scalar
progress survives each page. Tool events refresh existing demand, never acquire
an unviewed helper. The last parent viewer releases that read and fences late
publication. Split parts and legacy inline content contribute the same scalar
aggregate; without a proven SQL source helper summaries are explicitly
unavailable. Usage API fallback extracts and releases bounded pages. Session and
turn usage is known once any constituent reports usage, including zero;
unreported constituents do not erase reported values. With no reports it stays
null, even if native session totals are zero. Individual unreported categories
remain null. Native session totals include internal charges and need not equal
reply ledgers. This contribution does not enumerate projects or session lists;
V1 owns those. V2 detail carries the neutral `aggregation:"reported"` marker
through worker chunks to the shared live ledger. Omitted markers preserve
existing V1 complete-contributor accounting and empty-ledger behavior.

Helper revalidation publishes only semantic changes, including source witness
changes. Metadata-only publications omit the unchanged helper key. Requests
during an active helper pass coalesce through the same scheduler identity;
completed helper admission and idle ticks do not manufacture publications.
Viewer-owned reads apply the same semantic comparison before advancing their
client revision, retain progress through repeated outages, and coalesce refresh
requests while fencing obsolete results and released parent links.

Q6 prefetch reads only the next older page under the existing optional/idle
admission. Its adapter-wide memory-only FIFO charges complete encoded keys and
payloads, expires from insertion and rejects oversized entries. Hits skip native
body and scalar metadata acquisition and seal a new replay clock. Mutations,
metadata replacement, source/boundary changes and retirement cancel cached and
in-flight authority; speculation never recursively fetches another page.

## Existing-state upgrade boundary

Imported native identities are proven using the worker's read-only source
identity check before invoking an OTK-only transaction. The existing reference
upgrade now accepts a distinct marker, strict collision handling and injected
feature-owned metadata-reference contributions in that transaction. No blind
`opcv1-` replacement is performed. Matching retained legacy/V2 rows must share
identity, directory and creation clock in the proven file.
Unproven/deleted/foreign IDs must survive unchanged. Scope and allowlisted
metadata receipts join the reference transaction; request fingerprints,
certainty, dispatch clocks, journals and terminal retention must survive
unchanged. No native body or credential may enter a receipt. The marker commits
only with every contributor. The upgrade is awaited before feature hydration.
The shipped client's reserved `local` location is eligible; arbitrary
browser-owned remote sidecar IDs are not.

Tests: package contracts, `test:v2-foundation` and `test:v2-transcripts`, inside
the assigned droplet. Native selection runs in both lanes. No V2 parity area is
claimed merely by preparing a native binary or selecting a browser project.
