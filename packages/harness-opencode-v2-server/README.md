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

The adapter selects scalar connection/index facts, not unqualified action,
transcript or catalog capabilities. Their staged implementations compose into
the same owner. The worker's `core/digest/providers.ts` selects native codecs,
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
