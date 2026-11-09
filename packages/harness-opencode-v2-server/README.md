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

V0 selects only the foundation connection/index facts, not unqualified action,
transcript or catalog capabilities. Their staged implementations compose into
the same owner. The worker's `core/digest/providers.ts` selects native codecs,
private migrations and sink construction without changing scheduling or SQLite
ownership. V2 SQL selection and source proof belong to V1.

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
