# @otk/protocol

Harness-neutral OTK wire contracts and shared helpers, with no runtime
dependencies. This package does not connect to a harness or sidecar, parse
markdown, store data, or render a UI.

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

The package version is `0.1.0`; the wire protocol version is `13`, including
host-persisted keymap, Dark/Light/System theme and four notification channel
preferences. The canonical hello version field remains `protocol`.

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
menu controls and command actions. Theme IDs are bounded, nonempty identifier
strings, independent of installed palettes; missing palettes resolve to the
consumer's dark base at paint time, without changing the saved ID. System
retains OS-mode base selection. The shipped contract uses interface inheritance
rather than library-internal module augmentation, which JSR's publication graph
does not support. The composition names owners only, never individual keys or
validators.

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

The optional `models` capability supplies `listModels(sessionID)` and the
feature-owned `models.list { sessionID }` RPC. `ModelCatalog` contains only
connected providers' IDs/names and model IDs/names, variant names, status,
`free`, optional release date, optional reported `contextLimit` and optional
`cost` (input/output/cache read/cache write USD per million tokens); its
optional `default: ModelRef` identifies the configured model only when it is in
that catalog. Native credentials, options, headers and environment data never
belong in this contract. This new capability is not inferred for legacy servers.
`AgentOption` optionally carries neutral `color: AgentColor`, configured
`model: ModelRef` and `variant`; `UserMessage` optionally carries the recorded
`variant` alongside its `model` for restoration.

`AgentColor` is a concrete hex colour or the semantic role `accent` /
`secondary`; consumers resolve roles in their own presentation system.
Transcripts use the same contract. A task's optional `agent` contains only a
reported identity; absence never implies a specific backend agent. External
output's truncation flag reports truncation only, not a universal byte limit or
source.

The transcript preference owner contributes `showCost` and
`collapseFileChanges`, both on by default, with shared Display toggles and
preference command metadata. Cost visibility does not alter stored usage or
token counts. File-change disclosure is presentation-only and does not change
tool results.

`usage` is an optional capability, advertised only when implemented. Its
`usage.get {sessionID}` RPC returns a SessionUsage snapshot: full session and
user-message-keyed turn totals, per-model token categories/reported costs, and
minimal keyed UsageMessage baselines for exact live replacement, ordered call
clocks and existing tool-name/title metadata. ToolBase.sourceName preserves an
original operation label when the adapter normalizes it to a shared tool kind.
UsageLedger is the dependency-free aggregation owner shared by producers and
consumers; it stores no transcript parts, tool inputs or outputs. Each total's
optional time is the first call's start to the last call's end; an unfinished
call leaves the end absent. Keyed part updates preserve labels across
header-only replacements; published baselines are detached. Unknown capability
means unknown usage, never a loaded-page estimate. These additive contracts use
the existing open registries.

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
console.log(serialized); // {"t":"hello","protocol":13}
```

Outside this workspace, map `@otk/protocol` to a local checkout's `mod.ts` in
your Deno imports. The package is prepared for publication, but has not been
published to JSR.

Run `deno task check` and `deno task test` in this directory. The workspace's
`deno task test:unit` includes these package tests alongside remaining app
tests.

License: LGPL-3.0-only; see [LICENSE](./LICENSE). Source files retain their SPDX
headers.
