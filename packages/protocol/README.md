# @otk/protocol

`PROMPT_HISTORY_LIMIT` owns the global recall candidate/retention window.
`MAX_UPLOAD_BYTES` owns the immutable per-upload limit; `AttachmentPolicy`
describes injected aggregate reference/byte/concurrency admission. Recall and
upload preparation consumers share these feature bounds instead of copying
numeric limits. Protocol17 resolves recalled bytes through
`history.attachments {refs}` and returns `{items:[{ref,part}]}`; the old point
wire method is removed. Public native one-reference facades may still delegate
to the batch port. Welcome advertises the injected attachment policy plus the
immutable per-upload bound.

`MAX_SESSION_TITLE` owns rename validation, native-input bounds and safe failure
copy. `ACTIVITY_PAGE_SIZE` owns the application journal page, while the store
accepts an explicit lookahead count. `PathSemantics` names the server's lexical
POSIX/Windows flavor without consulting browser platform information.

The additive request-service contracts export `RequestRef`, `RequestControl`,
`RequestEvent`, progress/failure facts and injected request policies
independently of the currently selected wire union. `RequestReceipts` is
declaration-mergeable: features contribute exact allowlisted metadata rather
than arbitrary results. `OperationContext` carries action identity, lifecycle
cancellation, progress, effect fence and typed checkpoint ports.
`OperationFailure` distinguishes a definite rejection from unavailable reads and
unknown effect outcomes; its cause is diagnostic. `canonicalRequest` rejects
unsupported/nonfinite JSON inputs and `requestFingerprint` hashes their equality
representation asynchronously.

Shipped metadata receipt contracts live beside their feature contracts and are
composed into `RequestReceipts` by interface inheritance, following `RpcMethods`
and the JSR-compatible preference pattern. Task/project records, selected
preference snapshots, seen clocks and approval policy snapshots are explicit
metadata; body, history and catalog reads contribute no durable result payload.
External consumers may augment the same open receipt interface.

Harness-neutral OTK wire contracts and shared helpers, with no runtime
dependencies. This package does not connect to a harness or sidecar, parse
markdown, store data, or render a UI.

`errorMessage(unknown)` supplies nonempty feedback without assuming a thrown
value is an Error; strings and string-valued messages are preserved, other
values are encoded when possible, and unrepresentable values use
`Unknown error`. `normalizeError(unknown)` preserves actual Error identity
(including codes and stack), wrapping other values with their original value as
cause for Error-only ports. Transport and presentation failure boundaries share
these helpers.

## Public API

Import only `@otk/protocol`; `mod.ts` is the single public entry point.

| API                                                            | Purpose                                 |
| -------------------------------------------------------------- | --------------------------------------- |
| `ClientFrame`, `ServerFrame`, `HarnessState`                   | WebSocket frames and connection state   |
| `ContentSession`, `Message`, `Part`, `Block`, `ContentOp`      | Session content and incremental updates |
| Tool, diff, permission and question types                      | Harness-neutral structured content      |
| `IndexEntry`, `IndexOp`                                        | Live session index                      |
| `RpcMethods`, `RpcMethod`, `RpcParams`, `RpcResult`            | Open RPC contracts and derived names    |
| `Preferences`, `DEFAULT_PREFS`, `isPreference`                 | Preference contract and validation      |
| `HistoryEntry`, `sameParts`, `sameHistory`, `mergeHistory`     | Prompt history equality and merging     |
| `ErrorObservation`, `SessionErrorState`, `sessionErrorMessage` | Reconciled error observations           |
| `SessionLookup`, `sessionAncestors`, `belongsToSession`        | Cycle-safe session families             |
| `FrecencyEntry`, `frecency`                                    | Daily-decayed file scores               |
| `isPermissionOp`, `isAttentionOp`                              | Content operation classification        |
| `PROTOCOL_VERSION`, `SIDECAR_VERSION`                          | Existing wire and sidecar versions      |
| `MAX_CLIENT_FRAME_BYTES`, `checkClientFrameSize`               | Combined UTF-8 client frame budget      |

The package version is `0.1.0`; the wire protocol version is `17`, including
host-persisted keymap, Dark/Light/System theme and four notification channel
preferences. The canonical hello version field remains `protocol`.

Protocol17 retains provider-qualified session identities, validated by the
dependency-free `isSessionID` helper
(`<three-letter code>v<major>-<native id>`). Both session and root references
use this grammar; message, part, task, request and model identities remain
separate. A protocol-13 client must reload rather than send bare session
identities to a newer server.

Inbox baselines carry `{generation,revision,inbox}` in `inbox.snapshot` and
`inbox.get`. Live `inbox.patch` frames contain only keyed changes, with
`revision=from+ops.length`. The inbox owner alone reduces `InboxOp`; the session
index owner alone reduces `IndexOp`. Gaps retain last-good metadata and acquire
a complete baseline rather than inventing missing state.

The optional `catalogs` capability contributes `catalogs.watch {directory}` and
`catalogs.refresh {directory}`. A watch is a connection-bound, explicitly
releasable request lease. `DirectoryCatalogKinds` and `CatalogChunkKinds`
compose open per-feature interfaces from `catalogs/`. `createCatalogCodecs()`
selects the shipped codecs; independent consumers inject additional codecs
without editing transport dispatch. Metadata snapshots expose
preparing/ready/unavailable and last-good values. Contiguous `catalog.chunk`
transfers stage one complete kind before publication; chunks never expose a
partial usable list. Catalogs declare server path style and canonical file
paths.

`frecency.list` returns `{directory,revision,entries}`. Committed
`frecency.patch` frames carry keyed upserts/removals, including removals grouped
by the original directory when global retention prunes another directory.

`ModelCatalog.defaultState` distinguishes a reported configured default from
unknown, and `free` is `boolean|null`. Search pattern/count, diff path and todo
priority may be absent; unknown diff status is explicit.
`ToolBase.selectionIntent` can carry an adapter-reported neutral agent choice.
`message.clock` refines an existing message's last-output clock through the
ordinary ordered content channel; it cannot create a missing message or change
terminal state.

`session.messages` accepts `MessagePageInput` (`sessionID`, optional opaque
`before`) and returns `MessagePage`, not an array. `MESSAGE_PAGE_SIZE` is ten;
only `older: null` proves exhaustion. Pages carry coordinated session metadata,
`LatestPrompt`, turn boundaries/readiness and bounded clocked catchup.
`ContentClock` separates an epoch from its increasing sequence; content frames
carry that clock unchanged. Attention remains outside transcript sequencing.
`StreamStamp` identifies source generation/version and append authority;
`part.blocks.baseVersion` must match the previous published checkpoint exactly.

`MessagePolicy` has no library defaults. The composing application supplies
`coolms`, `preloadms`, `concurrency`, `replayops`, `replaybytes`, and `retryms`
through `welcome.messages` or an explicit standalone connection policy.
`messagePolicy` strictly validates positive safe integers, rejects unknown keys
and requires room for replay bookkeeping.

`RpcMethods` is an open interface containing each shipped method's wire `params`
and `result`. A feature declares additional entries beside its code using
`declare module "@otk/protocol" { interface RpcMethods { ... } }`. `RpcMethod`,
`RpcParams<M>` and `RpcResult<M>` derive from that interface; there is no
separate method-name list. Import the feature's contract in both server and
client consumers. `Rpc.call` infers its result from the method name, and the
application core checks registrations against that same contract.

`Preferences` is a declaration-mergeable composition of feature schemas. Each
shared feature module in `preferences/` owns its schema and contributes its own
default, validator and label through `PreferenceRegistry.register`. Registry
machinery imports no features. `createPreferences()` selects the shipped owners
into a fresh registry; `preferences`, `DEFAULT_PREFS` and `isPreference` expose
the shipped composition. An extension augments `Preferences` beside its
registration, and supplies the same selected registry to its server policy and
UI consumers. Register before constructing storage or mounting UI. `defaults()`
derives the selected snapshot; `validate` delegates only to the registered key's
validator. No coercion occurs. Optional display controls/ordering supply both
menu controls and command actions. Separate optional settings
group/order/control metadata supplies the selected registry's settings sections;
settings-only controls do not acquire Display command contributions. Both
presentations validate and freeze the same control contract. Theme IDs are
bounded, nonempty identifier strings, independent of installed palettes; missing
palettes resolve to the consumer's dark base at paint time, without changing the
saved ID. System retains OS-mode base selection. The shipped contract uses
interface inheritance rather than library-internal module augmentation, which
JSR's publication graph does not support. The composition names owners only,
never individual keys or validators.

The layout preference owner exports immutable `SHELL_WIDTHS` data for each
column's minimum, maximum and default. Preference defaults/validation and UI
resize consumers share that policy; collapsed rail geometry is a UI concern.

The model preference owner contributes `models.recent` (max 10) and
`models.favourite` (max 50), both initially empty arrays of unique
`{ provider, model }` references. Runtime validation rejects malformed,
duplicate and oversized lists; these are ordinary host-sidecar preferences, with
no catalog-membership requirement. `registerModelPreferences` is also available
for smaller compositions. Exported `MAX_RECENT_MODELS` and
`MAX_FAVOURITE_MODELS` keep next-value helpers aligned with validation.

`ToolKinds` and `PartKinds` are also declaration-mergeable interfaces, mapping
typed OTK kind names to their wire shapes. `ToolCall` and `Part` derive from
these maps plus `ExternalCall` / `ExternalPart`. Harness/MCP/plugin names live
in the external variant's `name`, never in a typed OTK discriminant. External
tool input/metadata and part data are bounded JSON text previews (possibly
truncated and therefore not parseable), not unbounded native objects. The stock
adapter caps each preview at 64 KiB UTF-8; tool summary/output bounds are
retained.

Every tool inherits optional `ToolBase.output` for native result text. Absence
and an empty result remain distinct; typed structural results (diffs, todos and
questions) remain available alongside it. The native adapter retains bash's ANSI
cleanup and external tools' 64 KiB preview bound. `ToolBase.outputContent`
optionally carries a decoded `ToolResult`: file text with language/native line
range/total/ truncation, path lists with pagination metadata, grep matches
`{path,line,text}`, skill content with directory/files, or text. `output`
retains the complete native result for provenance and fallback when its format
is unknown. Model-facing native envelopes are not UI result contracts.

`CapabilityContracts` composes the operation contracts owned by the shared
features in `capabilities/`. `CapabilityName` derives from its keys and
`Capabilities` makes those implementations optional. Harness registry/require,
welcome advertisements, client `supports` and UI gates all use that contract. An
extension declares `interface CapabilityContracts { "feature.name": MyPort }`
inside `declare module "@otk/protocol"` beside its own implementation, and
imports that contract in its consumers. No central name list is edited. The
shipped composition uses interface inheritance for JSR compatibility, just like
preferences. Harness re-exports the operation types for compatibility.

The wire representation remains a list of strings. Typed producers and gates
reject undeclared names; receiving a newer server's unknown names neither
filters the advertisement nor fails the connection. A missing advertisement uses
the original feature-owned legacy contributions; explicit empty/subset lists
remain authoritative. New extensions are never implicitly available on legacy
servers.

The optional `sessionActions` capability owns title and deletion mutations
through `rename(sessionID, title)` / `session.rename` and `remove(sessionID)` /
`session.delete`. It is explicitly advertised and never inferred from a legacy
welcome. Titles are trimmed and bounded to 1–200 characters by the feature's
server validator.

`SessionMetadata` is the live metadata write contract. Materialized `IndexEntry`
adds `SessionDigest` and an optional tombstone. `UsageSummary` categories are
independently nullable; reported zero is distinct from unknown. Digest patches
carry session scalars and only changed/removed turn keys. Global index frame
revisions fence duplicate/gapped frames; ordered accepted frames may carry
sequential parts under an equal session digest revision. Metadata writes and
digest writes have separate owners over the same identity. Optional `digests`
contributes owner-scoped priority hints, never a catalog filter or a legacy
capability promise.

`sessionActions.fork(sessionID, through?)` / `session.fork` creates a new
session through the supplied message (inclusive). Without a boundary it copies
the visible conversation, respecting a pending rollback.

`sessionActions.compact(sessionID, model)` / `session.compact` admits a summary
with an explicit next-prompt `ModelRef`; completion and `compact` request
failures use ordinary session events and error observations, not a long-running
RPC.

`restore` is a separately advertised capability: `restore(sessionID)` and
`session.restore` return the authoritative session after unreverting. Legacy
`revert` alone never implies Restore support. `RevertInfo` and live
`session.revert` operations optionally carry oldest-first `prompts` (at most 50,
200-character whitespace-collapsed previews) and a metadata-only boundary
`prompt: HistoryEntry` for draft recall. Older peers can omit both fields.

The optional `models` capability supplies `listModels(sessionID)` and the
feature-owned `models.list { sessionID }` RPC. `ModelCatalog` contains only
connected providers' IDs/names and model IDs/names, variant names, status,
`free`, optional release date, optional reported `contextLimit` and optional
`cost` (input/output/cache read/cache write USD per million tokens); its
`defaultState` is `configured` only when an optional `default: ModelRef`
identifies the reported configured model in that catalog. Native credentials,
options, headers and environment data never belong in this contract. This new
capability is not inferred for legacy servers. `AgentOption` optionally carries
neutral `color: AgentColor`, configured `model: ModelRef` and `variant`;
`UserMessage` optionally carries the recorded `variant` alongside its `model`
for restoration.

`AgentColor` is a concrete hex colour or the semantic role `accent` /
`secondary`; consumers resolve roles in their own presentation system.
Transcripts use the same contract. A late `agent.colors` content operation
carries available name-to-colour metadata independently of essential message
delivery; the receiver decorates its existing transcript. A task's optional
`agent` contains only a reported identity; absence never implies a specific
backend agent. External output's truncation flag reports truncation only, not a
universal byte limit or source.

The transcript preference owner contributes `showCost` and
`collapseFileChanges`, both on by default, with shared Display toggles and
preference command metadata. Cost visibility does not alter stored usage or
token counts. File-change disclosure is presentation-only and does not change
tool results.

`usage` is an optional capability, advertised only when implemented.
`usage.get {sessionID,turnID}` / `getUsage(sessionID,turnID,signal?)` returns
`TurnUsageDetail`: identity, digest revision, content checkpoint, nullable
`UsageSummary` and every charged call for that turn, independently of body pages
or rollback visibility. `AssistantMessage`, `UsageMessage`, `ModelUsage` and
`UsageTotal` retain nullable reported categories/costs; zero is never
substituted for unreported data. `UsageLedger` maintains subtract-old/add-new
turn/model aggregates and counted scalar extrema. `call(id)`, `turn(id)` and
mutation `{calls:{upsert,remove},turns}` change sets support keyed consumers
without snapshotting history. Its detached `snapshot()` remains an explicit
compatibility operation. No content parts, inputs or output enter the ledger.
Tool labels survive header-only replacement, and completed calls reject stale
unfinished headers. Missing capability never becomes a loaded-page usage
estimate.

File parts optionally carry their original `url` display source. Image renderers
can use that source for both a thumbnail and the original image; unavailable
sources remain absent rather than being inferred from backend filesystem paths.
History entries remain metadata-only and resolve upload bytes separately.

`ApprovalSnapshot` carries explicitly enabled session IDs and a
server-generation revision. `autoApproveOwner` supplies the shared cycle-safe
inheritance lookup; descendants inherit an enabled ancestor without creating
another policy row. `permission.auto` changes one session's boolean, and
`permission.activity` returns at most100 newest-first reply records with an
exclusive earlier-page cursor. Records distinguish manual/auto source, requested
action/target and started/confirmed/failed outcome. These server-owned contracts
are independent of browser preferences and native permanent permission grants.
`canAutoApprove` defines root-only explicit policy eligibility; the server
applies it to authoritative backend session metadata, and clients reflect it.
Policy revisions are separate from `approval.activity` invalidations, which name
the affected stored session families without carrying transcript or journal
rows.

## Example

Within the OTK workspace, Deno resolves the package by its name:

```ts
import {
  checkClientFrameSize,
  type ClientFrame,
  PROTOCOL_VERSION,
} from "@otk/protocol";

const hello: ClientFrame = { t: "hello", protocol: PROTOCOL_VERSION };
const serialized = JSON.stringify(hello);
checkClientFrameSize(serialized);
console.log(serialized); // {"t":"hello","protocol":17}
```

Outside this workspace, map `@otk/protocol` to a local checkout's `mod.ts` in
your Deno imports. The package is prepared for publication, but has not been
published to JSR.

Run `deno task check` and `deno task test` in this directory. The workspace's
`deno task test:unit` includes these package tests alongside remaining app
tests.

License: LGPL-3.0-only; see [LICENSE](./LICENSE). Source files retain their SPDX
headers.
