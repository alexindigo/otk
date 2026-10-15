# Kit dependency architecture

`deno task test:arch` checks the exact seven workspace libraries against the
kit-repackaging dependency table. It also checks root application/core/web/test
consumers for private paths into extracted packages and retired protocol,
harness, store and sidecar application paths. Package metadata must expose only
`mod.ts`; import maps cannot bypass workspace resolution. Protocol production
code cannot acquire external dependencies. Client production code depends only
on protocol, with no Solid imports or legacy networking/reducer escapes; the
standalone consumer imports only `@otk/client`. Solid state storage lives in the
UI library's thin bindings over that client.

The checks cover static imports, type imports, re-exports, side-effect imports
and literal dynamic imports. Uncheckable computed or escaped dependencies are
rejected in package production source. Negative fixtures exercise forbidden
edges and public-entry bypasses, rather than relying only on the current tree
being valid.

RPC names must derive from the declaration-mergeable protocol `RpcMethods`
interface. Negative fixtures reject closed aliases and extra literal method
names; core RPC tests compile and exercise an external feature contract through
server registration, direct calls and invocation-time selected calls.

Tool and part contracts derive from declaration-mergeable `ToolKinds` and
`PartKinds` interfaces plus separately discriminated external variants. Negative
fixtures reject closed unions, extra union members and closed registry aliases.
Renderer tests exercise feature-owned contracts and name collisions between
typed OTK kinds and external tools/parts; independent browser consumers verify
external rendering and unknown fallbacks.

Preferences compose an open protocol interface from their feature-owned shared
contracts in `packages/protocol/preferences/`. The policy registry imports no
owners; shipped composition selects registration functions, not individual keys.
Defaults and validation derive from contributions. Display menu and commands
consume the same display metadata. Negative fixtures reject central key/default
lists, key-specific registry dispatch, duplicated menu/command lists and closed
theme identities. Contribution tests observe command-driven persistence,
validation and notifications; browser tests observe unknown-theme base paint.

Native endpoints/schema belong to `@otk/harness-opencode1`. Store production
code cannot depend on another OTK package; app preference policy and error types
are injected. Its connection and migration runner cannot import feature modules.
Negative fixtures exercise that separation alongside registry-to-feature checks.
OTK's root application/core composes backend, feature registrations and assets;
it is not a separate sidecar/server/app library. Core RPC registry machinery is
implementation-free. HTTP routes remain reflective application files. Package
imports cannot escape into core or root bootstrap. UI part/tool dispatch uses
consumer-selected registries, whose machinery imports no features. Package tests
may use test dependencies, while cross-package imports still use public names.
App-level test support may use native endpoints for stock-server proofs.

The final composition check covers root server and browser entries, shared
production composition in fixtures, retirement of old extraction directories and
the duplicate subprocess launcher, and the application-owned reflective
catch-all. Both shipped and standalone browser consumers must resolve bare kit
names to the packages' declared public entries, rather than private bundler
seams. Negative fixtures retain checks for all retired paths and forbidden
app/server/sidecar package assumptions.
