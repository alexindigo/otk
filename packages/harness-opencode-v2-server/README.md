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

`V2Stream` owns one subscribed SSE generation. It waits for `server.connected`
before snapshot reads, stages events under the injected operation/byte budgets,
deduplicates durable positions and IDs, and pauses its 45-second byte watchdog
only for owned parser backpressure. Reconnect re-discovers credentials and
resyncs before readiness. Snapshot acquisition returns a fenced commit; abort
joins acquisition and event work before closing. Execution facts survive
decodable frames whose unrelated fields drift. The SDK event queue is unused.

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

After requested work drains, the shared scheduler can discover scalar sessions
in Active projects through bounded newest-first SQL keysets or native API
cursors. Project-policy and connection changes fence those cursors. This is not
a startup population catalog, another scheduler or a message-body scan.

Project seeds join the saved `/api/project` and `/api/worktree` inventories in
that worker. Native project identity bounds longest-checkout-root matching;
exact session directories stay list/task scopes. Empty inventory roots are not
invented populated projects. Failed inventory omits topology (retaining known
facts); complete retirement sends null. With unavailable SQL, topology remains
usable while population/count/recency stay unknown. This producer uses V6a's
neutral `ProjectTopology` shape; hierarchy/policy consumers belong to that item.

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

`V2Catalogs` borrows the shared `DirectoryCatalogs` owner. Agents retain
separate native IDs and display names; commands use unknown provenance when
native does not report it, and skill commands retain their skill IDs.
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

Pages contain ten native rows, chronological visible items, session metadata,
real-prompt/reply context and an event-aligned replay clock. Cursor
continuations omit native `order` and bind to session, epoch, cutoff and source
identity. Reconnect stages demanded running-turn backfill and checkpoints
retained streams before new deltas. Missing seeds use bounded replacement-only
recovery; HTTP snapshots never become append seeds. Unsubscribe, cutoff,
reconnect and stop fence late pages, recoveries, shell output and speculation.

`OpencodeV2TranscriptDigestSink` is the transcript contribution composed by the
selected `OpencodeV2DigestSink`. It borrows that scheduler, credited read
channel, derived SQLite owner and the index owner's source-proven read-only
native connection. Background headers and helper rows exclude text, tool inputs
and output. API fallback extracts and releases bounded pages. Reported usage
remains nullable; native session totals include internal charges and need not
equal reply ledgers. This contribution does not enumerate projects or session
lists; V1 owns those.

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
