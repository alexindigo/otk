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
cannot return late data. `V2Client.effect` fences each actual dispatch, has no
mutation timeout or replay, and preserves native rejection versus unknown
transport outcomes through SDK causal wrappers. Retiring a stream generation
aborts and joins its finite SDK exchanges before closing that owner.

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
Stock V2 listings have no ignored flag; no ignore status is invented. Only
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

Tests: package contracts plus `tests/integration/harness-probe_test.ts` and
`tests/integration/v2-foundation_test.ts` inside the assigned droplet. The
latter is V2-specific, while native selection runs in both lanes. No V2 parity
area is claimed by merely selecting a browser project or preparing its native
binary.
