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

`ToolKinds` and `PartKinds` are also declaration-mergeable interfaces, mapping
typed OTK kind names to their wire shapes. `ToolCall` and `Part` derive from
these maps plus `ExternalCall` / `ExternalPart`. Harness/MCP/plugin names live
in the external variant's `name`, never in a typed OTK discriminant. External
tool input/metadata and part data are bounded JSON text previews (possibly
truncated and therefore not parseable), not unbounded native objects. The stock
adapter caps each preview at 64 KiB UTF-8; tool summary/output bounds are
retained.

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
