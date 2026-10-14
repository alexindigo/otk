# Staged dependency architecture

`deno task test:arch` checks all existing workspace packages against the
kit-repackaging dependency table. It also checks remaining sidecar/web/test
consumers for private paths into extracted packages and retired protocol,
harness, store and sidecar application paths. Package metadata must expose only
`mod.ts`; import maps cannot bypass workspace resolution. Protocol production
code cannot acquire external dependencies. Client production code depends only
on protocol, with no Solid imports or legacy networking/reducer escapes; the
standalone consumer imports only `@otk/client`. Solid state storage remains in
the application's thin web binding until UI extraction.

The checks cover static imports, type imports, re-exports, side-effect imports
and literal dynamic imports. Uncheckable computed or escaped dependencies are
rejected in package production source. Negative fixtures exercise forbidden
edges and public-entry bypasses, rather than relying only on the current tree
being valid.

Native endpoints/schema belong to `@otk/harness-opencode1`. Store production
code cannot depend on another OTK package; app preference policy and error types
are injected. Its connection and migration runner cannot import feature modules.
Negative fixtures exercise that separation alongside registry-to-feature checks.
OTK's root application/core composes backend, feature registrations and assets;
it is not a separate sidecar/server/app library. Core RPC registry machinery is
implementation-free. HTTP routes remain reflective application files. Package
imports cannot escape into core or root bootstrap. Existing UI dispatch remains
until its planned extraction chunk. Package tests may use test dependencies,
while cross-package imports still use public names. App-level test support may
use native endpoints for stock-server proofs.
