# Browser measurement contracts

## Native fixture readiness

`OpencodeTest.start` and `restart` join the native tool registry through
`GET /experimental/tool/ids` in the fixture directory after HTTP health. Both
steps share the existing 60-second bootstrap budget. Health alone can succeed
while native custom tools still wait for config-directory dependency installs;
that waiting belongs to fixture preparation, not the first question's UI budget.
No LLM prompt is manufactured for preparation. The V7 plan-switch assertions and
their timeouts are unchanged.

A local-registry barrier regression proves that a healthy fixture cannot publish
while its native custom-tool dependencies are held, and that its actual custom
tool appears after release. The controlled V7 probe identifies the pending
package as `@opencode-ai/plugin`, not the bundled provider SDK: holding those
config-directory installs prevents the first question and all provider requests;
releasing them lets the original browser flow complete. Package preparation and
resource disposal use the separate contracts below; preparation never replaces
the actual native readiness join.

## Native menus

DOM visibility (`:popover-open`) is earlier than the native `toggle` task and
the Menu owner's focus effect. A DOM-only wait can complete, measure and dismiss
several corner invocations within one rendering turn, leaving the owner's native
lifecycle pending. `menuReady` joins Popover's published `data-open` state,
Menu-owned focus and two stable rendered placement frames before the next
action. Placement is measured on the painted Surface, with positive content
geometry; the native panel remains the lifecycle/anchoring owner. All
context-menu browser suites share this readiness contract; their original
viewport/non-overlap assertions and tolerances remain unchanged. A controlled
real-consumer probe proves the old predicate reports ready before any native
open event or menu focus; a native-browser control preserves that regression.

## Highlight latency

R-perf measures **visible source revision → rendered, styled marker range**. It
prepares TypeScript through a real cold reply first and reports that startup
separately; provider admission, transport and grammar startup are not streaming
update latency. One large 2000-line source range has its own 200 ms assertion.
Twenty individually released subsequent updates each contribute exactly one
sample (nearest-rank p95 = nineteenth sorted update). This isolated service-time
check is followed by **240 free-running updates at the original 100 ms provider
cadence**, with no consumer acknowledgement or active scroll/demand helper. A
passive MutationObserver records each distinct source revision and its newest
marker; token-only DOM replacements do not create revisions. Coalesced provider
markers belong to one actual source revision, never fabricated samples. All240
markers must be accounted for, with at least200 complete revision observations
(at least ten observations in the p95 tail). Each phase independently retains
the same **200 ms** nearest-rank p95 budget; populations are never pooled.

Each sample identifies its own source marker, records first-source and first
actual viewport demand separately, and finishes only on an animation frame with
the marker's token and computed style. Offscreen intentional deferral is not
counted as active highlighting time. The observer scans only the current reply's
requested code range. One shared range/style observer owns both modes: it
disconnects after an acknowledged sample, or tracks overlapping revisions until
the free-running phase ends. Neither mode submits, releases, scrolls or alters
the producer. Missing, unpainted or insufficient samples fail instead of being
excluded from the percentile population. Its own cumulative execution time and
read count are recorded in the performance artifact, along with every revision's
source length, first-source/demand/style timestamps and markers. Cold-startup
latency is logged and persisted alongside the two distributions, without adding
a startup budget (that remains a user decision).

The unchanged zero-main-thread-long-tasks-over-50-ms budget applies from the
first demanded source through the last styled update **in each phase**. Gaps
between phases and startup/navigation are outside those intervals. This is a
strict **code workload** budget, not a claim that every renderer task in that
interval was caused by Shiki. Startup/navigation lie outside that interval.
Trace events remain available for diagnosis. A real Chromium control uses a
renderer that styles isolated revisions within200ms but is starved by updates
every100ms; the acknowledged check accepts it and the passive check rejects its
actual per-revision p95. Missing and unpainted populations are also rejected.

`highlightedRange` repeatedly resolves the particular marker's actual text
range, establishes viewport demand, checks two stable rendered frames and
observes that range's token style. It never substitutes backend idle or an
arbitrary token for rendering readiness. Tool-result checks use this contract
both live and after reload; later tool activity cannot invalidate an earlier
one-shot scroll.

## Session release

E8 and code-history release use **reachable session-content identity**, not
bytes allocated by the entire V8 isolate. A 2 MiB ASCII reply does not imply a 2
MiB allocation increase: strings can share representations. Conversely,
framework/grammar/cache warmup can grow the isolate after correct disposal.

The measurement unit therefore changes from whole-isolate byte delta (old 1 MiB
allowance) to retained session objects, marker-bearing strings and detached
transcript DOM nodes (**zero allowed in every category**). The payload remains
at least 2 MiB in E8; its DOM length is checked. This is not a larger byte
allowance. Three equivalent load/dispose cycles each take one loaded and one
post-disposal GC snapshot. Loaded snapshots positively identify message objects
by `sessionID` + `parts`, and source-bearing objects by their unique `text` or
`source` marker. Post-disposal snapshots must contain none, including any copied
objects with that identity. Strong root reachability excludes weak edges and
unreferenced entries in the snapshot's string table. Every string node type is
examined through the snapshot JSON's names and string edges, independently of
the retaining owner's shape. Bounded prefix/suffix summaries detect markers
across concatenated-string boundaries without expanding ropes. Sliced strings
keep their backing parent reachable, including content outside the slice.
Chromium's snapshot string-name limit is set to UINT_MAX (above every valid V8
string length), rather than the default 1024 characters; a flat 2 MiB
tail-marker control guards against silent truncation. Primitive strings are
never resolved as remote objects.

Blink native Text content may have no corresponding V8 string. The DOM agent's
detached trees are therefore checked for marker-bearing text and transcript
root/message classes, including empty transcript roots. Only matching detached
trees are resolved temporarily to associate their native heap IDs with the same
sample's strong root paths. Heap IDs, kinds, types, immediate incoming retaining
edges and complete root paths are reported on failure. The transient object
group is released and the DOM agent disabled in finally before any later sample.

Post-disposal sampling follows replacement transcript readiness and two render
frames; code history additionally waits for the owned worker target to
terminate. Sampling is fixed, never repeated until a heap number passes.
Unsubscribe and DOM absence remain independent assertions. Existing client
generation/cancellation and highlighting-disposal units cover the deterministic
owner contracts.

The measurement-control browser tests deliberately retain identifiable content
alongside an unrelated large allocation, proves retention is rejected, then
releases only the content and proves the unrelated allocation cannot cause a
false leak report. Independent closure-held Map, flat tail, sliced backing,
split cons, detached native text and empty-transcript controls each require
retention rejection with strong paths, followed by zero retention after removing
the sole owner. Markers are constructed from character codes outside evaluated
source literals so debugger/source strings cannot masquerade as content leaks.

## Fixture lifetime

Tests that acquire fixtures import `test` from `tests/support/resources.ts`. It
runs the ordinary Deno test, with its existing operation/resource sanitizers,
inside one async resource scope. There is no global Deno-test patch. A
standalone helper such as the showcase uses `withResources` around the same
lifetime.

The scope owns every temporary directory and immediately registered service
disposer. `TMPDIR` must already exist on the assigned VM's project disk; unset,
relative and OS temporary/runtime paths are rejected. Child opencode and
Chromium processes receive private TMPDIR children so extracted libraries,
browser sockets and profiles disappear with the owning fixture. Package-local
temp factories use the same owner. Temporary-directory paths stay readable until
test completion, including explicit post-stop evidence readers.

Acquisition transfers a child scope only after setup completes; rejection
unwinds that child before returning. Restart registers a fresh process lifetime
and stops it on readiness failure. A process group remains owned after its
leader exits; stop sends TERM, escalates to KILL if needed, joins the leader and
observes that no live group members remain. CDP closes pending calls on
transport loss or send failure; socket open/close and teardown have failure
bounds.

Every disposer is idempotent and joined. Explicit finally cleanup records errors
in its scope rather than overwriting a test-body failure. Evidence collection
and reverse-order disposal attempt all owners, even when a capture or disposer
fails; the eventual error retains both primary and cleanup failures.
Native/browser and raw HTTP/WS fixtures register their listener/transport
lifetime immediately.

Before scratch removal, root-level JSON, HTML, PNG, log and heap-snapshot
evidence is exported to `OTK_TEST_ARTIFACTS`, or `.test-state/artifacts` by
default. Each export has its test identity and failure metadata. XDG databases,
dependency trees and Chromium profiles are scratch, not exported evidence. A
fresh run root owns its artifact retention; the test never deletes an earlier
run's evidence.

Lifetime measurements compare complete before/after TMPDIR and fixture-directory
inventories, process identities (PID plus start time) and listeners around both
a focused run and the full canonical gate. The acceptance result is zero new
scratch, run-owned processes and listeners; explicitly exported evidence is
accounted for separately. Process ownership follows the runner's descendants and
their owned process groups, including descendants reparented after a leader
exits. The dedicated supervisor unit's inherited cgroup retains that ownership
across double forks and sampling gaps. Complete global process inventories and
external-service replacements are retained as separate observations; an
unrelated desktop-session service restarted by its own supervisor cannot fail
the run's process-lifetime check. A passing test process is insufficient: the
failed-acquisition control also attempts to bind the acquired provider's actual
port before diagnostic cleanup, observing a listener that ordinary Deno test
exit can hide.

## Shared native packages

The fixture-bearing test tasks prepare dependencies automatically inside the
assigned OTK VM. `deno task test` (including focused file/filter arguments),
`test:unit`, `test:integration`, `test:e2e` and `test:reuse` run the shared
`prepare:test` prerequisite before any tests. No manual setup is required on a
fresh workspace. `test:arch` is read-only and has no native fixtures. Direct
`deno test` bypasses task prerequisites; prepare first with
`deno task prepare:test` when deliberately invoking that lower-level runner.

The prerequisite can also be invoked on its own:

```sh
deno task prepare:test
```

This uses a real custom-tool registry read to populate stock1.18.34's config and
project dependency path. With no custom tool, the registry can return built-ins
before that path exists; health or built-in IDs alone are not cache preparation.
The native SDK used by the scripted provider is bundled; the characterized live
install is `@opencode-ai/plugin` and its transitive provider dependencies.

`OTK_TEST_PROVIDER_CACHE` optionally selects the cache; the default is
`provider-cache/opencode-1.18.34` beside TMPDIR, outside disposable scratch.
Preparation checks the installed opencode binary's version before using that
version's cache. The binary, native health, prepared plugin, package lock and
ready manifest must all match the fixture's pinned1.18.34 contract.

Independent task processes join one exclusive kernel file lock and revalidate
after acquiring it. The `.lock` inode stays beside the cache (never unlink it
while runners may be waiting); process exit releases ownership automatically.
Preparation builds a private sibling staging directory, validates it, then
publishes atomically. Failure removes its staging and releases the lock. A
present but invalid cache fails without overwriting it or silently attempting a
live install. Repeated valid preparation leaves the published cache untouched.
Only the first cold prerequisite needs the registry; subsequent test tasks use
the validated cache even with registry access denied.

Each fixture copies the two package manifests into its own global and project
config directories and links only the prepared dependency tree. Auth, config,
state, data and native cache directories remain isolated. Ordinary fixtures
cannot populate a missing package cache from npm. Only the task prerequisite and
the dedicated uncached readiness barrier select `packageCache: false`.

The offline regression starts two independent native instances with a denied
registry. Each must expose its actual custom tool and finish a scripted provider
reply, while the registry receives zero requests. Native tool-registry readiness
and the existing first-question assertions remain independent requirements. The
task regression starts two independent cold tasks against one absent cache,
requires exactly one preparation and real custom-tool/provider outcomes in both,
then repeats the task with registry requests denied and checks that the
published manifest is unchanged.

The cold-task and uncached-readiness regressions own their package source via
`packageRegistry`. It serves a synthetic, dependency-free `@opencode-ai/plugin`
package at the pinned native version, including local metadata, tarball and npm
audit responses. These tests exercise native install/readiness, concurrent task
preparation and offline reuse, not the plugin SDK API. Their tools use plain
definitions; actual native tool catalogs and completed provider replies remain
required. Cold preparation asserts that its lock resolves to the test's local
source, uses private npm caches and rejects unexpected registry requests. The
readiness test holds that source until after health, then releases the install.
Neither regression forwards to a public registry. Synthetic packages stay in the
cold test's temporary cache; ordinary fixtures keep the real shared cache.
