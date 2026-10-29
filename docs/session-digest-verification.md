# Session digest qualification

The scale fixture is generated against the selected stock opencode executable,
not a hand-written approximation of its database schema. It boots an isolated
XDG tree, records that version's schema and migration metadata, stops its owned
server, populates the characterized tables transactionally, then restarts the
same server and checks its HTTP catalog and message pages.

| # | Population                          | Count  |
| - | ----------------------------------- | ------ |
| 1 | Sessions across project directories | 4,615  |
| 2 | Sessions in the main project        | 251    |
| 3 | Messages in that project            | 27,205 |
| 4 | Messages in its largest session     | 1,525  |
| 5 | Parts in that session               | 5,672  |

The independent manifest includes expected session and turn totals, unknown
categories, actual zero and sub-cent charges, charged reverted calls, helpers,
an orphan, a deep chain, old sessions and an archived session. This establishes
population/history amplification, **not a 60-GB storage or I/O benchmark**.

## Execution boundary

Run project workloads only inside virtual machine
`arch-niri-otk-devbase-otk-m5a` on `ark.home`, through the strict `otk-vm` /
`otk-m5a` access profile. Stage a fresh source tree beneath
`/home/tester/otk/.test-state/beta2-m1/`; run fmt/lint only in that isolated
source. Set `TMPDIR=/home/tester/otk/tmp`. If the guest is unavailable, stop
rather than run on a physical host.

From that isolated **guest** source directory:

```sh
export PATH=/home/tester/.deno/bin:/usr/local/bin:/usr/bin
export TMPDIR=/home/tester/otk/tmp
deno task test tests/integration/session-scale_test.ts
deno task build:web
deno task test tests/e2e/session-scale_test.ts
```

For a retained standalone fixture, choose a new destination inside the guest
workspace; an existing destination is refused:

```sh
deno run --allow-net --allow-read --allow-write --allow-env --allow-run \
  tests/support/session-scale.ts \
  --root /home/tester/otk/.test-state/beta2-m1/scale-manual \
  --sessions 4615 --project-sessions 251 --project-messages 27205 \
  --largest-messages 1525 --largest-parts 5672
```

`--fixture-root` may explicitly name the allowed disk-backed parent. Otherwise
the CLI uses the project workspace containing `TMPDIR`. The generator never
opens operator-configured state. Test-owned fixtures use the normal resource
scope and clean up their processes and XDG trees; the explicit CLI destination
and its manifest remain on disk.

## What the probes observe

The serving-isolate probe begins at the injected digest-admission boundary,
before the module Worker is created. User-data schema construction precedes this
boundary. Once sampling starts, no timer outliers are discarded. A 5-ms timer
records interval minus requested delay, alongside synchronous worker message
application, index observer and serialization sections. A deliberate
same-isolate block is a negative control. Every serving sample is retained and
reported, including samples above the historical 50-ms reference. Worker slice
wall time is recorded separately, not misreported as main-thread blocking.
Timing and heap values are measurements, not pass/fail gates; structural and
consumer-correctness assertions still gate verification.

The optional injected diagnostics have no operator flag or debug RPC. Native
read counts come from the worker's actual native reader. Summary scans must
perform zero part/tool reads, and header reads are bounded by population and
page count. The integration consumer compares the complete wire snapshot with
the independent manifest, rather than accepting only database readiness.

Browser instrumentation is installed before navigation. It timestamps receipt of
the complete index snapshot using the browser clock and observes the first
animation frame with real titles, lights, selection and row geometry. Both cold
and warm list paints are reported against the historical 1,000-ms reference.
WebSocket frames distinguish the selected session's body/resources from list
demand: list rows admit no detail or per-row body requests. The real browser
also observes saved task and native interactive outcomes while digestion is
active.

The attention scenario deliberately asks for permission in two background
sessions. Their two notification-owned `permission.list` reads are counted
separately by identity; they are not list demand. The cold project-open phase
still asserts zero requests for nonselected session identities. The same fixture
then proves working, blocked and unseen-finished lights through a
collapsed-panel reload, followed by window bounds, focus, search, native rename
and task reorder.

The full milestone gate additionally runs unit, architecture, reuse, source and
off-source compiled checks. Compatibility runs select stock 1.19.3 and 1.18.35
with `OTK_TEST_OPENCODE`; the default executable is 1.18.34. Raw samples,
manifests and build identities belong with each execution receipt, not in this
document as timeless performance claims.

## Message paging and cooling measurements

The message fixture retains the same population and adds a 102-step reply,
helper-heavy parent, long code/diff, queued prompts and a unique-source payload.
Tests record five cold and preloaded newest-page paints per theme, real native
cursor traversal and reverse reuse, 1,000 real streamed updates, and ten full
load/cool heap cycles while another session keeps the highlighting worker alive.
Paint, event-loop, highlighting, reserve-at-input-cadence and retained-byte
values are reported without threshold failures. They are not promises for every
install.

Exact page/source/cursor identity, bounded shared acquisition, no helper scans
or per-row usage/body requests, truthful admitted outcomes, stable visible
nodes, settled viewport bounds, subscription retirement, preserved drafts and
the continued independent worker lifetime remain structural assertions. Heap
instrumentation controls still verify that the measuring tool observes known
retained and released fixture content. Raw samples and heap artifacts accompany
the execution handoff.
