# Load contracts

## Demand-driven loading

`complete` proves the requested boundary under its source generation, not full
history, source exhaustion or `older: null`. Interactive demand is never
idle-gated. Optional backfill and message prefetch require `digest.idlems`
without requests, a viewer or `digest.background`, and at most `digest.parallel`
admitted entry-batches. Lamps remain independent. Waiting yields execution
(AXIOM 2). Positive native terminal inventories are mandatory supervision
demand: they stream bounded scalar metadata through the existing credited worker
read channel, without acquiring bodies, usage, helpers or the ordinary session
catalog. OTK acknowledgements, never native viewed state, decide which finishes
are unseen.

Current-folder choice warm-up is separate from idle backfill: one page-ready
input currently releases models, agents, commands and skills at project
acquisition. Those reads use revocable background admission, without an idle
silence delay. Consumer demand promotes/joins the same kind; essential reads
interpose and cancellation joins native cleanup. Other kinds require their
consumer, and files start only on a file mention/completion. A passive watch
does not acquire any kind or enumerate other folders. Proofs:
`tests/unit/catalog-demand_test.ts`,
`packages/client/tests/server-resources_test.ts` and the `@load` catalog-demand
case in `tests/browser/behavior/composer/model-picker.spec.ts` on both natives.

All contracts below have permanent integration/browser proofs tagged `@load`
plus their owning areas. Integration tags are in test names; Playwright tags are
test metadata. Supporting unit proofs run in the full unit gate.

| # | Contract                                                                                                                                                                                        | Permanent proof                                                                                                                                                                                    |
| - | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1 | Cold/warm startup reads project seeds and lamps, never a per-session catalog/header/helper/replay population; 130 templates have no lamp; explicit inactive policy yields to mandatory activity | `tests/integration/demand-loading_test.ts`, "project-only cold and warm startup"; `tests/browser/behavior/sessions/projects.spec.ts`                                                               |
| 2 | Frequent real HTTP/WS requests admit zero optional batches; silence admits bounded parallel work; a new request parks the next chunk; disconnected background off/on and live lamps             | `tests/integration/demand-loading_test.ts`, "real client ingress" and "disconnected background"; `packages/harness/tests/digest-scheduler_test.ts`; `tests/integration/background-viewers_test.ts` |
| 3 | Page 1 returns 20 of 500; unrelated growth does not increase requested SQL rows; exactly one high-priority successor; search/append retain anchors and mounted-row bounds                       | `tests/integration/demand-loading_test.ts`, "project demand returns 20 of 500"; `tests/browser/scale/demand-loading.spec.ts`                                                                       |
| 4 | Newest-first metadata stops at the inclusive boundary, extends older, advances high then normal one batch per break, removes completed membership, then discovers other Active projects         | `tests/integration/demand-loading_test.ts`, "metadata demand stops newest-first"; `packages/harness-opencode-v1/tests/digest-checkpoint_test.ts`                                                   |
| 5 | Atomic bodies paint before metadata; matching boundary alone completes; held sources retain rows, after 60 seconds report the actual wait, and never move existing content                      | `tests/integration/demand-loading_test.ts`, "replies complete only their requested boundary"; `tests/browser/behavior/sessions/progress.spec.ts`                                                   |
| 6 | Combined metadata/newest page; next older memory hit reads zero native HTTP/SQL; TTL, FIFO, oversize/byte bounds and mutation/revert/reconnect authority fences                                 | `tests/integration/demand-loading_test.ts`, "idle prefetch"; `packages/harness-opencode-v1/tests/message-pages_test.ts` and `message-prefetch_test.ts`                                             |
| 7 | Replacement/reconnect reject stale scopes, cached restart retains authority, lamps/phantoms remain visible outside acquired lists                                                               | `tests/integration/view-lease_test.ts`; `packages/client/tests/server-resources_test.ts`; `tests/browser/behavior/sessions/{axiom,projects,progress}.spec.ts`                                      |
| 8 | Full-turn 102-call totals finish after idle without loading detail; copying still acquires all 203 reply segments exactly                                                                       | `tests/browser/behavior/messages/pages.spec.ts`, "native-102-step-ledger-offpage-copy"                                                                                                             |

Run in `/home/tester/otk` inside `otk-tests-a` on `ark.home`, with disk-backed
`TMPDIR=/home/tester/otk/tmp`, through `scripts/test-vm.py` or strict `otk-vm`
SSH: `deno task test:prepare --version 1.18.34`, `deno task test:integration`,
`deno task test:e2e --project=oc-1.18.34 --grep '@load|@smoke' --retries=0`, and
`deno task test:scale --project=scale-1.18.34 --grep @load --workers=1 --retries=0`.
Unit contracts run with the full `deno task test:unit` gate.

Q7's one LOAD-2 measurement uses 120 seconds connected-idle then 120 seconds of
active clicking. CPU, native reads and admitted work are reported against P6,
with dataset/window differences; they are measurements, never pass thresholds.

## Fixed-demand population budgets

`@load` varies 200/4000 unrelated nonempty sessions and 10/130 discovered
projects while keeping one selected session and a 1280x800 viewport. It observes
the browser's first 30 seconds with HTTP requests every 100 ms, and native
startup plus that active-request window. Rule 6 deliberately permits unrelated
native reads after idle; it does not permit unrelated session wire delivery.
Browser method counts and non-catalog native endpoint counts must be equal
across populations. Catalog endpoint counts and their aggregate share fixed
ceilings. Unrelated-session RPCs, including batched scope identities, and
discovered-directory native reads are zero. Index entries contain only the
leased session; every project has one keyed summary.

The native catalog ceiling is independent of observed counts: seven shipped
catalog codecs (`packages/protocol/catalogs/codecs.ts`) x five owner acquisition
or refresh sources = 35 per endpoint at either population. Those sources are
initial lease acquisition, native-instance reset, and `catalog.updated`,
`integration.updated`, `reference.updated` in
`packages/harness-opencode-v1/catalogs.ts`. This fixed startup budget
accommodates coalescing/preemption order within the shared catalog acquisition
set; it is not a bound for arbitrary later user refreshes, edits or reconnects.
The eight native catalog endpoint families in `catalog-reads.ts` share the
aggregate ceiling 8 x 35 = 280 at both population sizes. Neither ceiling is
fitted to observations.

The owner already joins per-kind in-flight work and repeats reads after dirty
invalidation; revocable native I/O can restart after essential preemption. Exact
per-catalog endpoint attempts can therefore drift without growing with
population. The budget is derived from owner composition and refresh sources,
not the measured `/command` or `/question` counts. Priority, idle pause and zero
digest-only projection recomputation are separate permanent contracts in the
same area.
