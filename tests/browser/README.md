# Browser test tooling

This private Node island owns Playwright Test and its TypeScript check. It does
not import Deno runtime helpers or product implementation paths. Deno continues
to own the application build and existing tests. Tooling acceptance lives only
under `tooling/`, selected by `playwright.tooling.config.ts`; ordinary browser
configs must select their own test directories.

Run preparation and verification only inside the assigned OTK test VM, from
`/home/tester/otk`, with this disk-backed environment:

```sh
export PATH=/opt/otk-test/node/bin:/home/tester/.deno/bin:/usr/local/bin:/usr/bin
export TMPDIR=/home/tester/otk/tmp
export PLAYWRIGHT_BROWSERS_PATH=/opt/otk-test/ms-playwright
npm --prefix tests/browser ci
npm --prefix tests/browser exec -- playwright install chromium
npm --prefix tests/browser run check
npm --prefix tests/browser run acceptance:tooling
```

Node 24.22.2 (npm 11.19.1), Deno 2.9.6 and the exact dependencies in
`package.json` are the preparation contract. Use Playwright's matching managed
Chromium, preserving stock Chromium for the Deno consumers. On Arch, install
needed native libraries/fonts with pacman, not `playwright install-deps`.
Prepare each native version's provider cache through the existing
`tests/support/prepare-provider-cache.ts`, selecting `OTK_TEST_OPENCODE` and
`OTK_TEST_PROVIDER_CACHE` per version. Never use real provider credentials.

Provisioning records `.test-state/provisioning/toolchain.json` with schema 1,
guest UUID, tool versions, source URLs, archive/executable SHA-256 hashes,
installed pacman package versions, fonts, managed browser revision and paths,
and per-version native executable/cache paths. Preserve it with source manifests
and verification logs before sealing a base. Missing exact artifacts or an
incompatible platform block preparation rather than changing pins.

Acceptance observes a trusted button click at an accessible counter, Unicode
input readback and nonzero viewport-centered geometry. It writes the
observations, full screenshot and runner report under
`tests/browser/test-results/` in the guest workspace; these are evidence, never
committed source.

## Worker-owned application tests

All commands below run in `/home/tester/otk` inside `otk-tests-a` on `ark.home`
with the plan's strict SSH route and environment, including
`TMPDIR=/home/tester/otk/tmp`. Select the matching native/cache for other
assigned version guests; never run these workloads directly on a physical host.

```sh
deno task test:prepare --version 1.18.34
deno task test:e2e --project=oc-1.18.34 --grep @smoke --retries=0
deno task test:e2e --project=oc-1.18.34 --grep @fixture-acceptance --workers=3 --retries=0
deno task test:e2e:legacy tests/e2e/workspace_test.ts tests/e2e/cdp_test.ts
```

Preparation hashes the complete delivered source selection (excluding private,
dependency and generated files), invokes the existing shipped compile recipe
once, and records native/cache/binary/web hashes in
`.test-state/builds/<tree>/receipt.json`. The compile recipe owns its frozen
install and web build. A browser invocation validates that exact receipt before
admitting workers; it neither installs dependencies nor builds in a test case.
The legacy task defaults to all `tests/e2e/` files when no explicit files are
given. It preserves their Deno runner and assertions.

Import `test`/`expect` from `fixtures/evidence.ts` for ordinary journeys.
Request `state` only when the test needs native services. Its worker owns the
Deno controller, native process, sidecar and scripted provider. Each test owns a
fresh context and Git directory. Use `state.newContext(browser)` for extra
contexts; the same test owner closes them before resetting state.
`state.product` derives RPC types from the protocol's public `mod.ts`; the real
RPC execution remains in Deno's existing `WsClient`. `state.native` keeps
fixture ID/directory routing. `state.queue` provides held or consumer-stepped
scripts without timing guesses.

Use `isolatedTest`/`isolatedState` from `fixtures/isolated.ts` for global or
restart contracts. Its lazy graph does not acquire the ordinary worker stack.
Browser-only consumers likewise request a context/page without `state`.
Preparation also owns the existing independent consumer compositions; test cases
serve their content-qualified assets through `consumerAssets`. Add `--scale` to
preparation to generate or validate versioned native templates; see
[`../support/snapshots.md`](../support/snapshots.md) for the stopped-copy,
relocation, controller and acceptance contracts.

The version-1 checked JSON-lines channel has correlation IDs and fixture leases.
Control traffic is private stdin/stdout; diagnostic output stays on stderr.
Controllers run in uniquely named guest user units with
`KillMode=control-group`. Stop acknowledges only after resource-scope cleanup
joins; EOF/signals also unwind ownership. A run inventory lets the supervisor
stop and verify exact controller units after worker replacement or abrupt death.
No process-name cleanup or product test endpoint exists.

Run roots include guest/version/shard/run UUID; worker identities include
`workerIndex`, and test directories include stable test identity/attempt UUIDs.
Native/sidecar explicit ports use one run-owned lease namespace. Preferences are
restored key-by-key through existing RPCs and joined broadcasts; owned tasks,
sessions and auto-approval policies are retired normally. Native directories
remain until worker disposal. Script queues must settle; unexpected or unused
scripts fail cleanup and poison that worker lease instead of being discarded.

Reports, timing lines, bounded provider/native/browser observations and
first-failure trace/video/screenshots live under `.test-state/runs/<run>/`.
Evidence capture precedes reset, and capture failure cannot skip teardown.
Harness negative controls run as checked child invocations, preserving their
expected failures without putting intentional failures in ordinary discovery.

## Browserless integration lanes

In the named test guest, run `deno task test:prepare --version 1.18.34` before
integration. Its exact-tree receipt contains both the shipped executable and the
independent digest-consumer executable. `deno task test:integration` admits only
the standard top-level files with `DENO_JOBS=3`;
`deno task test:integration:scale` admits only `tests/integration/scale/` with
`DENO_JOBS=1`. Each invocation prints and retains its explicit selected-file
list, actual job count, exit and elapsed time under `.test-state/runs/`. Keep
these pools sequential with browser lanes.

The runner supplies `OTK_TEST_BINARY` and `OTK_TEST_DIGEST_CONSUMER_BINARY` from
the validated preparation receipt. For a raw explicit `deno task test FILE`
compile-consumer invocation, set these inputs to the same receipt paths first.
Compile consumers refuse missing or stale inputs instead of building in a case.
Destination-refusal and timing-instrumentation controls remain standard;
full-population snapshot and structural scale proofs run in the scale lane.
