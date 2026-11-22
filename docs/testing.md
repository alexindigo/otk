# Developer testing

All builds, tests, browsers and experiments execute inside `otk-tests-a`
(1.18.34), `otk-tests-b` (1.18.35) and `otk-tests-c` (1.19.3) on `ark.home`, in
`/home/tester/otk`, with `TMPDIR=/home/tester/otk/tmp`. If unavailable, stop;
never fall back to a physical host. `otk-vm` documents the strict pinned route.
Node/Playwright are test tools only; shipped installs need neither.

| # | Developer intent     | Ark transport                                                                                                        | Guest work                                                                   |
| - | -------------------- | -------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| 1 | Normal commit check  | `python3 scripts/test-matrix.py --lane commit --base HEAD`                                                           | A normally; shared changes fan out to A/B/C; dirty source and smoke included |
| 2 | One browser area     | `python3 scripts/test-vm.py otk-tests-a run -- deno task test:e2e --project=oc-1.18.34 --grep @composer --retries=0` | Fresh context/project; trusted native outcomes                               |
| 3 | Provider integration | `python3 scripts/test-vm.py otk-tests-b run -- deno task test:integration`                                           | Deno file-parallel; matched 1.18.35                                          |
| 4 | Theme/style change   | `python3 scripts/test-vm.py otk-tests-a run -- deno task test:themes --project=themes`                               | One state sweep                                                              |
| 5 | Heavy data/heap      | `python3 scripts/test-vm.py otk-tests-c run -- deno task test:scale --project=scale-1.19.3`                          | Explicit isolated scale                                                      |
| 6 | Milestone/release    | `python3 scripts/test-matrix.py --lane full --guests otk-tests-a,otk-tests-b,otk-tests-c`                            | Complete tiers/versions, scale and compiled upgrades; themes once            |
| 7 | Trace investigation  | `python3 scripts/test-vm.py otk-tests-a run -- npm --prefix tests/browser exec -- playwright show-trace TRACE_PATH`  | Browser stays in guest; use actual retained path                             |

Transport runs on Ark only: receipt, domain UUID/MAC/storage, QGA IP, strict
ED25519 pin, guest DMI/account and disk workspace must agree. Source delivery
includes dirty/untracked files and checksum receipts, excludes secrets and
generated trees, reconciles only prior source-owned removals and preserves guest
extras. Reports live under
`~/TemporaryFiles/otk/plans/test-suite-rearchitecture/evidence/c16/`. Transport
never imports product code or runs a host workload.

## Selection and lanes

`test:commit --changed-paths FILE` takes repository-relative NUL-delimited
paths, not line-delimited text. Ark collects explicit base-to-working-tree paths
with rename compression disabled (old and new names), deletions and untracked
source. The guest evaluates `tests/browser/areas.json`; `--areas composer,menus`
unions with automatic areas and smoke. Missing base or unknown paths select
broad standard coverage across A/B/C plus themes. Docs alone select
static/unit/arch and smoke. Scale changes opt into scale; ordinary changes
exclude it. Native, SQL, protocol and transport changes also request full
milestone qualification. Every collected test needs an area; unknown areas and
accidental empty selections fail visibly. Receipts name the source tree, base,
selection reasons and outcomes.

Guest tiers run sequentially: static/unit/arch, prepare, selected integration,
behavior/contracts, relevant themes/scale. `test:full --version VERSION` runs
complete unit/arch/reuse, integration, behavior, scale, compiled/upgrade and the
visible quarantine lane; themes run only on A. Full matrix transport starts all
three guests in parallel and awaits every receipt; one failure fails
aggregation. Targets of 15 minutes selected and 45 minutes full are
measurements, not gates.

For a repaired version lane, `--lane full --guests otk-tests-a` executes that
guest's complete lane. The receipt records the selected `guests` and sets
`matrixComplete` only when all three version lanes were collected; a subset
receipt does not replace the other guests' qualification evidence.

`--shard=1/2` and `--shard=2/2` pass through to Playwright with separate run,
project, shard and attempt output roots and blob reports. Run extra shards
sequentially on their version guest.
`npm --prefix tests/browser run
acceptance:sharding` verifies the disjoint union
against unsharded collection and executes both real smoke shards. Browser report
rendering/merging belongs in A, never on Ark.

## First attempts and quarantine

The four smoke IDs are native metadata tags, retained in each outcome row:
`smoke.native-prompt`, `smoke.attention`, `smoke.navigation` and
`smoke.preferences`. They cover real incremental provider output/reload,
collapsed-panel background permission/file completion, history/drafts with a
rejected dirty-editor release, and cross-context preference persistence.
Collection rejects a missing or duplicate smoke owner.

Only full-matrix transport enables one automatic retry. Ordinary/focused checks
have zero retries; `failOnFlakyTests` is always true. First-pass, flaky, failed,
quarantined and not-run are separate report categories. Flaky and not-run fail
qualification. Failed first-attempt trace, screenshot, video, browser evidence
and fixture logs remain in their unique run roots, including after a passing
retry.

`quarantine.json` starts as `[]`. Reviewed entries require stable test title
`id`, exact `project`, `reason`, diagnosed `failureClass`, `issue`, named
`owner` and future ISO UTC `expiry`. Collection rejects unknown, duplicate,
incomplete and expired entries. Full qualification runs active entries in a
visible zero-retry lane. Failure/flakiness/not-run still fails the aggregate. A
passing active entry is labeled `passed; active quarantine metadata`. Tooling
never adds quarantine. `acceptance:reporting` owns the deliberately flaky child
outside ordinary discovery and proves its nonzero exit and retained
first-attempt artifacts.

Fixture/provider revisions invalidate matching snapshots. UI-only changes reuse
native datasets and rebuild exact-tree assets. New tests belong in the Node
browser island or the explicit Deno tier; the migration ledger audits ownership.

## PR checks

`Full-house PR checks` runs on PRs to `master`, pushes to `master`, and manual
dispatch. It uses GitHub-hosted Ubuntu 24.04 guests, not self-hosted machines or
cloud credentials. Fork PRs use the same read-only token and need no secrets.
The workflow never uses `pull_request_target` or persists checkout credentials.

| # | Job per native version                                                                                  | Slices   | Timeout      |
| - | ------------------------------------------------------------------------------------------------------- | -------- | ------------ |
| 1 | Base: prepare, fmt, lint, check, unit, arch, no-product-hooks, reuse, collection, quarantine, migration | 1        | 60 min       |
| 2 | Prepare and integration                                                                                 | 1        | 60 min       |
| 3 | Prepare and integration-scale                                                                           | 1        | 60 min       |
| 4 | Prepare, collection and browser                                                                         | 4 shards | 60 min each  |
| 5 | Prepare and browser-scale, when admitted by the migration ledger                                        | 2 shards | 120 min each |
| 6 | Prepare and themes (2.2.6 only)                                                                         | 1        | 60 min       |

There are 19 test jobs across opencode 1.19.3 and 2.2.6, followed by
`full-house`. Each runs `deno task test:full` with explicit tiers/shards. The
branch's `scripts/ci/provision.sh VERSION` installs the pinned Node, Deno,
native binary, provider cache and Chromium, verifies native/denort hashes, and
activates the user systemd bus. Deno, npm, browser, native and provider caches
are keyed by their versions or source hashes. Temporary fixtures stay in
`$RUNNER_TEMP/otk-tmp`, outside the Git checkout. The 2.2.6 integration job also
provisions 1.19.3 for the native migration test.

`full-house` proves every expected job, tier and browser shard ran exactly as
planned, and every receipt names the same source tree. A missing receipt or
shard fails the check, as do test failures, flaky results and not-run tests.
Every tier still runs after a failed tier. Full-matrix runs allow one retry; a
passing retry does not turn a flaky result into a passing qualification.

Read the `full-house` job summary for failing IDs and coverage errors. On PRs,
it compares failures with the latest completed master push record and labels
them "new in this PR" or "also failing on master". Both labels still fail the
check. Until a master record exists, the summary says no baseline is available.
The master record is `failing-ids-master`; each job's receipts, JUnit and logs
are `receipts-JOB`. Failed jobs also retain traces, screenshots and video in
`diagnostics-JOB`. Artifacts expire after 14 days.

The workflow does not configure branch protection or required checks. Its first
GitHub run happens only when the CI branch is published with user approval;
local rehearsal is not a claim that GitHub Actions has run successfully.
