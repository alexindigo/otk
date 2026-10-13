# Staged dependency architecture

`deno task test:arch` checks all existing workspace packages against the
kit-repackaging dependency table. It also checks remaining sidecar/web/test
consumers for private paths into extracted packages and retired protocol paths.
Package metadata must expose only `mod.ts`; import maps cannot bypass workspace
resolution. Protocol production code cannot acquire external dependencies.

The checks cover static imports, type imports, re-exports, side-effect imports
and literal dynamic imports. Uncheckable computed or escaped dependencies are
rejected in package production source. Negative fixtures exercise forbidden
edges and public-entry bypasses, rather than relying only on the current tree
being valid.

Native endpoint confinement and registry-to-feature separation apply to
extracted package production code. Legacy adapter/history ownership and existing
central RPC/UI dispatch remain in place until their planned chunks extract them.
Registries are checked as those modules appear; this first chunk has none.
Package tests may use test dependencies, while cross-package imports still use
public names. App-level test support may use native endpoints for stock-server
proofs.
