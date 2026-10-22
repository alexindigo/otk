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
releasing them lets the original browser flow complete. Dependency caching and
fixture cleanup remain separate responsibilities.

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
sample. Nearest-rank p95 is the nineteenth sorted update, not the maximum of two
blocks' first-token observations. The **200 ms** budget is unchanged.

Each sample identifies its own source marker, records first-source and first
actual viewport demand separately, and finishes only on an animation frame with
the marker's token and computed style. Offscreen intentional deferral is not
counted as active highlighting time. The observer scans only the current reply's
requested code range, and disconnects after that sample. Its own cumulative
execution time and read count are recorded in the performance artifact.

The unchanged zero-main-thread-long-tasks-over-50-ms budget applies from the
first demanded source through the last styled update. This is a strict **code
workload** budget, not a claim that every renderer task in that interval was
caused by Shiki. Startup/navigation lie outside that interval. Trace events
remain available for diagnosis.

`highlightedRange` repeatedly resolves the particular marker's actual text
range, establishes viewport demand, checks two stable rendered frames and
observes that range's token style. It never substitutes backend idle or an
arbitrary token for rendering readiness. Tool-result checks use this contract
both live and after reload; later tool activity cannot invalidate an earlier
one-shot scroll.

## Session release

E8 and code-history release use **reachable session-content object identity**,
not bytes allocated by the entire V8 isolate. A 2 MiB ASCII reply does not imply
a 2 MiB allocation increase: strings can share representations. Conversely,
framework/grammar/cache warmup can grow the isolate after correct disposal.

The measurement unit therefore changes from whole-isolate byte delta (old 1 MiB
allowance) to retained session objects (**zero allowed**). The payload remains
at least 2 MiB in E8; its DOM length is checked. This is not a larger byte
allowance. Three equivalent load/dispose cycles each take one loaded and one
post-disposal GC snapshot. Loaded snapshots positively identify message objects
by `sessionID` + `parts`, and source-bearing objects by their unique `text` or
`source` marker. Post-disposal snapshots must contain none, including any copied
objects with that identity. Heap IDs and immediate incoming retaining edges are
reported on failure. No remote object handles are retained by the observer.

Post-disposal sampling follows replacement transcript readiness and two render
frames; code history additionally waits for the owned worker target to
terminate. Sampling is fixed, never repeated until a heap number passes.
Unsubscribe and DOM absence remain independent assertions. Existing client
generation/cancellation and highlighting-disposal units cover the deterministic
owner contracts.

The measurement-control browser test deliberately retains identifiable content
alongside an unrelated large allocation, proves retention is rejected, then
releases only the content and proves the unrelated allocation cannot cause a
false leak report.
