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
cannot return late data. Native mutations need their separate effect owner.

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

Tests: package contracts plus `tests/integration/harness-probe_test.ts` and
`tests/integration/v2-foundation_test.ts` inside the assigned droplet. The
latter is V2-specific, while native selection runs in both lanes. No V2 parity
area is claimed by merely selecting a browser project or preparing its native
binary.
