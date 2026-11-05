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
