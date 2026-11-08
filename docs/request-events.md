# Request events and recovery

OTK protocol **17** gives actions and reads the same observable lifetime:
admission, pending progress and a correlated result. Connection state is
separate from operation state. A slow or disconnected operation is not reported
failed merely because a liveness interval elapsed.

## Identity and delivery

A client captures one intent before asynchronous preparation. Its identity is
`(principal, clientID, key)` in a server-issued admission window. Transport
attempts have separate IDs. Reconnecting or explicitly retrying unchanged work
reattaches to that intent; it does not allocate another key. Reusing a key with
different parameters is rejected before execution.

The server acknowledges admission before running the handler in a later turn.
Request sequences belong to that request, independently of transcript/index
revisions. A replayed acceptance can establish a newer sequence snapshot before
progress or a result. Resume frames are bounded by `requests.resumebatch`.
Releasing one read subscriber does not cancel another subscriber; releasing the
last read subscriber releases its demand. Detaching a mutation's presentation or
socket does not undo its effect.

Same-session ready effects execute in admission order. Waiting for readiness or
I/O yields the executing turn; its ready continuation re-queues behind already
ready work. A native-dependent metadata validation cannot hold up an independent
local write such as disabling auto-approve. Native effects keep a separate
same-session ordering permission through HTTP settlement, so a later ordinary
native effect cannot overtake an earlier one. Features explicitly declare
`ordering: "target"` when conflicting metadata needs its own lifetime permission
(the feature's resource, or its method/session target), so an older pending
enable cannot overwrite a later disable and membership intents for the same task
retain their order. A resource identity alone does not imply serialization:
closing a task remains independent of held membership validation, which must
revalidate ownership before writing. Independent metadata does not borrow either
permission. Interrupts retain their explicit priority bypass. Neither yielding
nor re-queuing resends a handler or weakens its intent duplicate fence, atomic
metadata receipt, dispatch fence or cancellation cleanup.

Registrations distinguish strictly local metadata from `prepared-local` metadata
that needs authoritative native validation. Both persist local atomic
completion; only the latter may resolve native identities. Task membership,
seen, frecency and enable-only approval validation declare that preparation
explicitly. Policy disable itself performs no native read and remains available
offline.

`request.received` releases volatile delivery data, not the durable duplicate
fence. Read bodies larger than the aggregate replay budget are delivered in full
and then reacquired through the authoritative reader when needed. The consumer
must resupply captured parameters when the server no longer has them; metadata
receipts cannot reconstruct a prompt, body or discarded read input.

## What a result proves

| # | Operation class      | Result and recovery contract                                                                                                                                                                                                                       |
| - | -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1 | Local metadata write | The effect and allowlisted completion receipt commit in one SQLite write scope. Restart returns the original outcome without repeating a task creation, visit clock or frequency increment. A later authoritative broadcast remains authoritative. |
| 2 | Native mutation      | A durable dispatch fence precedes backend invocation. A confirmed returned identity is checkpointed before local bookkeeping. If OTK loses the response before that checkpoint, recovery does not resend the mutation.                             |
| 3 | Read                 | Results are volatile. Restart/replay can reload current provider data, with cancellation and generation ownership preserved. A native read deadline reports backend liveness while the browser operation remains pending.                          |
| 4 | Connection lease     | Disconnect releases that socket's lease. The replacement connection applies its current scope rather than recovering an obsolete lease.                                                                                                            |

OTK and stock opencode do not share a transaction. An unconfirmed native effect
can remain **Checking whether this finished** until identity-specific evidence
establishes an outcome. Generic idle activity, elapsed time, a matching title or
the disappearance of an approval is not evidence that this particular action
succeeded or failed. There is no repeat-effect Retry action for this state.

Prompt submission completes when the native async endpoint confirms it was sent;
the agent's subsequent reply has its own lifecycle. Shell, command and
compaction wait for their owned HTTP exchange. A transcript may therefore show
completed native work while its operation still awaits HTTP settlement. Captured
input is retained until reliable admission/settlement evidence; a newer edited
draft is never cleared by the older result. Successful sends are not made to
look unsent by later visit/location bookkeeping.

Text missed during a native stream gap appears when the part finishes;
unfinished native HTTP parts do not expose that missing source.

## Storage, retention and upgrades

`otk.db` contains durable request windows and metadata receipts alongside tasks,
preferences and other user state. Keep it in backups. `digest.db` is a separate
rebuildable cache; rebuilding it must not erase request fences. Request receipts
contain no message bodies, prompts, answers, shell text, attachment bytes,
credentials or raw exceptions. Local user metadata such as a TaskRecord can be
retained as the immutable original result.

New intents require a live server-issued window. Known pending receipts remain
resumable after that window expires. Terminal receipts are retained through the
window expiry plus the configured minimum retention. Active or uncertain work is
never evicted to free capacity. An expired unknown key is rejected rather than
being silently executed again. Capacity rejection occurs before acceptance.

Login, setup and discovery use the same event contract over HTTP before an
authenticated WebSocket exists. Their origin-bound receipt secrets and input
equality hashes are memory-only. Cookies accompany successful terminal delivery,
not acceptance, and can be replayed during that live receipt lifetime. Following
a server restart, interrupted login needs explicit sign-in; setup first rereads
the committed configuration instead of submitting setup again.

Startup composes the feature schemas, including request receipts and the tasks
index, then runs the application-owned atomic beta.1 session-reference upgrade
before constructing features or starting the backend. Existing tasks/order,
preferences/layout, seen/finish marks and approval data are retained. There is
no invented historical request backfill: old calls did not have intent keys. Old
browser protocol peers must reload. Downgrading to beta.1 after the reference
migration is unsupported; restoring an older backup cannot reconstruct native
evidence that was never checkpointed. Restore does not create a cross-database
exactly-once guarantee.

Policy is layered through the tracked defaults: `[requests]`, `[connection]` and
`harness.requestms`. Browser liveness never aborts an effect or fabricates a
failure. Libraries receive policy from their composition rather than duplicating
defaults. Failure copy comes from the shared presenter at the captured target's
single feedback surface; raw native exceptions stay diagnostic-only.

## Qualification

Run workloads only in `otk-tests-a/b/c` on `ark.home`, through the pinned
receipt-bound `otk-vm` route, in `/home/tester/otk` with disk-backed
`TMPDIR=/home/tester/otk/tmp`. Stop if unavailable. From Ark, after exact-source
delivery, use the [testing transport](testing.md):

```sh
python3 scripts/test-vm.py otk-tests-a run -- deno task test:prepare --version 1.18.34 --scale
python3 scripts/test-vm.py otk-tests-a run -- deno task test:integration
python3 scripts/test-vm.py otk-tests-a run -- deno task test:e2e --project=oc-1.18.34 --grep @transport --retries=0
python3 scripts/test-vm.py otk-tests-a run -- deno task test:scale --project=scale-1.18.34
```

The compiled proof builds with the tracked recipe when `OTK_TEST_BINARY` is
absent; it never silently skips. It launches off-source with empty runtime
caches, replays one persisted `perf` task after lost result acknowledgement and
process replacement, then verifies one native create after losing its HTTP
response and replacing OTK again. Stock opencode remains alive throughout that
native crash leg. Source and compiled variants use the same proof.

The native browser proof separates actual shell output from held HTTP
settlement, reconnects and checks the newer draft after the final result. Scale
uses the existing stock-schema fixture: **4,615 sessions, 251 sessions / 27,205
messages in one project, 1,525 messages / 5,672 parts in the largest session**.
Admission tests exercise bounded active keys, replay bytes and reconnect
batches; browser tests observe exactly one selected task. The retained
session-scale suites prove complete summaries and absence of per-session list
demand. Timing and heap measurements are reported; structural assertions remain
gates.

The full milestone gate and complete integration/browser compatibility pairs run
sequentially on one frozen tree. `OTK_TEST_OPENCODE` selects stock 1.19.3 or
1.18.35; the default is stock 1.18.34. The scripted provider uses no model
account. An individual passing probe is not a claim that the entire matrix
passed.
