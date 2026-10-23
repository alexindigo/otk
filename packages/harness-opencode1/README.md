# @otk/harness-opencode1

Stock opencode 1.x implementation of `@otk/harness`, verified against 1.18.34.
All native endpoints, raw shapes, cursor encoding and read-only database
projections live here. Depends only on `@otk/protocol`, `@otk/content` and
`@otk/harness` plus the existing pinned standard path library and Node SQLite.

```ts
import type { Harness } from "@otk/harness";
import { Opencode1Adapter } from "@otk/harness-opencode1";

const harness: Harness = new Opencode1Adapter({
  harness: {
    url: "http://127.0.0.1:4097",
    username: "opencode",
    password: "",
    db: "/home/tester/.local/share/opencode/opencode.db",
    heartbeattimeout: 25,
    reconnectmax: 30,
  },
  index: { days: 30 },
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
inputs. All twelve optional capabilities are implemented in separate modules and
share one session-directory resolver. Use `core` for lifecycle/session queries
and `capabilities.<name>` for optional operations.

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

The public entry also exposes native raw types, mapping utilities, `Client`,
`HttpFailure`, `History`, `BootstrapDb`, SSE/watchdog utilities and
`TaskProgress` for native integrations. Cross-package imports always use this
entry.

The standalone sessions consumer and stock-server test are in `tests/reuse/` at
the workspace root. Run `deno task test:reuse` in the dedicated OTK guest.
Native unit tests live in this package; mixed app-consumer checks retain their
shared app fixtures. Tool mapping retains native output on the common tool
contract. `tool-results.ts` decodes characterized stock 1.18.34 read, directory,
glob/list, grep, skill and task formats once, into harness-neutral user results.
File lines retain native numbering/range and total/truncation metadata; grep
matches carry path/line/text. Model-only wrappers and instruction envelopes
remain in raw provenance, not user content. Unknown or inconsistent formats
retain the complete verbatim fallback. Read/write language inference has one
shared native owner. License: LGPL-3.0-only.
