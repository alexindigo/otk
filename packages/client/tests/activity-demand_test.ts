// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals } from "@std/assert";
import { createApprovals, type InboxRpc } from "@otk/client";
import { fixtureRequests } from "../../../tests/support/request-wire.ts";
import { fixtureMessagePolicy } from "../../../tests/support/message-pages.ts";

const tick = () => new Promise((done) => setTimeout(done, 0));
Deno.test("Activity demand releases reads, ignores hidden invalidations and fences old leases", async () => {
  const reads: { signal?: AbortSignal; resolve(value: unknown): void }[] = [];
  const model = createApprovals({
    call: ((_method: string, _params: unknown, signal?: AbortSignal) =>
      new Promise((resolve) =>
        reads.push({ signal, resolve })
      )) as InboxRpc["call"],
  }, () =>
    undefined);
  model.receive({ t: "approvals", approvals: { enabled: [], revision: 0 } });
  void model.selectActivity("root");
  for (let i = 0; i < 100; i++) {
    model.receive({ t: "approval.activity", sessions: ["root"] });
  }
  await tick();
  assertEquals(
    reads.length,
    0,
    "selection without a mounted lease issues no reads",
  );
  const first = model.retainActivity("root"),
    second = model.retainActivity("root");
  await tick();
  assertEquals(reads.length, 1);
  first.release();
  assertEquals(reads[0].signal?.aborted, false);
  second.release();
  assertEquals(reads[0].signal?.aborted, true);
  assertEquals(model.state.activity.entries, []);
  const replacement = model.retainActivity("other");
  await tick();
  second.release();
  assertEquals(
    reads[1].signal?.aborted,
    false,
    "old cleanup cannot release a replacement",
  );
  reads[0].resolve({ entries: [], before: 999 });
  reads[1].resolve({ entries: [], before: 12 });
  await tick();
  assertEquals(model.state.activity.sessionID, "other");
  assertEquals(model.state.activity.before, 12);
  replacement.release();
  model.receive({
    t: "welcome",
    protocol: 17,
    requests: fixtureRequests(),
    messages: fixtureMessagePolicy,
    sidecar: {
      version: "test",
      harness: { kind: "test", version: "1", url: "http://127.0.0.1" },
    },
  });
  model.receive({ t: "approvals", approvals: { enabled: [], revision: 0 } });
  model.receive({ t: "approval.activity", sessions: ["other"] });
  await tick();
  assertEquals(reads.length, 2);
  model.stop();
});
