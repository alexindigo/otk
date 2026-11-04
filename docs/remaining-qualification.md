# Remaining projection qualification

The beta.2 remaining-work tests exercise complete directory acquisition, keyed
user metadata, origin-batched provider reads and source-free retained UI state.
The existing session/message/request scale suites remain part of qualification;
these tests supplement their actual native source, cursor, cancellation,
viewport, cooling, uncertain-outcome and supervision assertions.

## Fixtures and observations

Current owners are `tests/integration/scale/remaining-scale_test.ts`,
`tests/browser/scale/remaining.spec.ts`,
`tests/browser/scale/task-overflow.spec.ts`, and the shared
`tests/browser/themes/sweep.spec.ts`. The historical source names in the
transfer table below identify the original proofs;
`tests/browser/migration.json` records their complete current destinations.
Behavior runs once in Dark; theme geometry runs in the separate Dark/Linen/Stone
sweep.

| # | Test owner                                                                | Observable contract                                                                                                                                                                                                                                                                                                                                           |
| - | ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1 | `tests/integration/remaining-scale_test.ts`                               | 4,615 tasks/marks and251 tasks in one directory: list/get use two set statements, seen/task edits publish one keyed op. Ten exact provider attachments across two independent origins use two batches; a rejected member cannot mutate the captured draft or admit partial preparation. Provider bytes are absent from both OTK databases.                    |
| 2 | `tests/e2e/remaining-scale_test.ts`                                       | The existing4,615-session generator with251 sessions/27,205 messages in one project, a1,525-message/5,672-part session,251 tasks and10,000 file candidates. A late candidate reaches the actual provider after local completion edits/cycling; file watches and task patches reach Chromium without another catalog request or inbox baseline.                |
| 3 | `tests/e2e/task-overflow_test.ts`                                         | 251 idle tasks occupy one chrome row at600/800/1280/1920px in Dark/Linen. Selected and working/blocked/unseen-finished tasks remain in the measured row. Only pinned tasks wrap under pressure; More contains independent omitted identities and navigates the correct target.                                                                                |
| 4 | `tests/integration/beta2-upgrade_test.ts`, `tests/support/beta1-state.ts` | Frozen beta.1 schema, independent expected records for two users and100 approval journal rows, preserved member ordering, clocks, layout/preferences and uncertain started state. Failures before/after each new schema feature and at each reference-upgrade checkpoint roll back and retry after reopen. No development backfill enters the product schema. |
| 5 | `tests/integration/compiled-beta2_test.ts`                                | Tracked compilation recipe, off-source working directory and empty runtime caches; beta.1 upgrade, complete catalog refresh, keyed task result, real native prompt body, no body persistence and restart. The executable's advertised version must match the source's exported release constant, including after release preparation.                         |
| 6 | `tests/reuse/remaining_test.ts`, `remaining-consumer.ts`                  | 251 session borrows share one directory lifetime;100 partial transfers cannot restore retired values.100 projects×10 visits retain getter-backed current inputs, selected identity and project-scoped metadata rather than per-tab detached index/mark maps.                                                                                                  |

Catalog demand is scoped to each accepted connection generation, identified by
its actual socket hello/welcome: exactly one `catalogs.watch` and one
`frecency.list`, zero catalog refreshes and zero legacy per-key discovery calls.
A real reconnect legitimately acquires that pair again. The fixture observes the
real native watch lease and subscription, asserting every retired watch is
released and detached, with no late publication; closing the final browser joins
the final lease release too. The assertion's negative controls reject duplicate
demand, missing loads, refreshes and leaked prior-generation leases.

## PA evidence

| #   | Concern                            | Evidence owner                                                                                                                                                                                                                                                                                  |
| --- | ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| PA1 | Large history/diff DOM and paint   | Existing message-scale, runtime-scale, window and giant-part tests observe source/cursors, settled row bounds and actual browser paint. No second virtualizer is introduced.                                                                                                                    |
| PA2 | Eager source serialization         | The independent remaining browser consumer holds its work fold closed through1,000 updates. Its injected lazy source getter records zero serialization/body mounts until explicit Copy; the real clipboard must equal the complete current source.                                              |
| PA3 | Abandoned reads                    | Existing request cancellation and body cooling proofs remain selected; the remaining reuse test adds100 retired partial directory lifetimes and late-completion fences. Mutations retain their original pending/effect semantics.                                                               |
| PA4 | Shared encoding and paused readers | One Chromium process supplies1/4/16 independently connected app tabs. The actual Connections diagnostic counts one encoding per common publication; a paused reader must receive every ordered state after resume. Raw encode/fanout times and heap are reported.                               |
| PA5 | Retained tab copies                | The independent public-entry consumer checks current project partitions and canonical inbox identity after1,000 visits and index/inbox replacement, with GC/heap and old-mark reachability observations.                                                                                        |
| PA6 | Registration/listener lifetime     | The remaining source consumer counts actual hidden command registrations through update and unmount/remount cycles. Browser DOM/listener/heap counters supplement the existing native listener and cooling cases; rapid warm-navigation counts alone do not prove a cooled leak or its absence. |
| PA7 | Static delivery                    | Real browser resource waterfall plus warm same-document navigation records script/style/font transfers. Compiled proofs separately cover off-source startup with no runtime downloads.                                                                                                          |

`tests/support/remaining-measurements.ts` writes raw samples, fixture
populations, Deno/native versions and the supplied `OTK_TEST_TREE` to exported
JSON. An unfrozen run labels itself explicitly. Times and heap values are
measurements, not pass/fail thresholds; source identity, exact counts/order,
scope, teardown, complete values and end-consumer outcomes remain assertions. A
no-additional-change PA disposition requires completed measurements.

## Execution

All builds, tests and experiments run in `otk-tests-a`, `otk-tests-b` and
`otk-tests-c` on `ark.home`, `/home/tester/otk`, with
`TMPDIR=/home/tester/otk/tmp`. Use the receipt-bound `otk-vm` route; stop if
unavailable. From Ark, use the [testing transport](testing.md):

```sh
python3 scripts/test-vm.py otk-tests-a run -- deno task test:prepare --version 1.18.34 --scale
python3 scripts/test-vm.py otk-tests-a run -- deno task test:integration:scale
python3 scripts/test-vm.py otk-tests-a run -- deno task test:scale --project=scale-1.18.34
python3 scripts/test-matrix.py --lane full --guests otk-tests-a,otk-tests-b,otk-tests-c
```

Normal full-suite discovery also runs these cases. The unchanged milestone gate,
complete supported-native compatibility runs and independent re-gate qualify the
frozen tree separately from a focused result. A launched or interrupted gate is
not a passing receipt.
