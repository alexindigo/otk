// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals, assertRejects, assertStrictEquals } from "@std/assert";
import { RequestTracker, Rpc } from "../mod.ts";
import type { RequestControl } from "@otk/protocol";

function connection() {
  const sent: RequestControl[] = [];
  const tracker = new RequestTracker({ send: (frame) => sent.push(frame) });
  tracker.connect(
    { id: crypto.randomUUID(), expiresAt: Date.now() + 10000 },
    2,
  );
  const rpc = new Rpc((frame) => sent.push(frame as RequestControl), tracker);
  const requests = () =>
    sent.filter((frame) => frame.t === "request") as Extract<
      RequestControl,
      { t: "request" }
    >[];
  return { rpc, tracker, requests };
}
const permission = {
  requestID: "per_1",
  sessionID: "s",
  reply: "once",
} as const;

Deno.test("one native permission admits one settlement across independent callers", async () => {
  const { rpc, tracker, requests } = connection();
  // A view, its remount and a notification each start their own call.
  const first = rpc.start("permission.reply", permission);
  const remount = rpc.start("permission.reply", { ...permission });
  assertStrictEquals(remount, first);
  assertEquals(requests().length, 1);
  await assertRejects(
    () => rpc.call("permission.reply", { ...permission, reply: "reject" }),
    Error,
  );
  assertEquals(requests().length, 1);
  // A different request is independent.
  rpc.start("permission.reply", { ...permission, requestID: "per_2" });
  assertEquals(requests().length, 2);
  rpc.receive({
    t: "request.result",
    ref: first.state.ref,
    seq: 1,
    outcome: { ok: true, result: null },
  });
  assertEquals(await first.result, null);
  // The request stays answered while its removal event is still in transit.
  assertStrictEquals(rpc.start("permission.reply", permission), first);
  assertEquals(requests().length, 2);
  tracker.stop();
});

Deno.test("only a failed or unsubmitted released settlement frees its request", async () => {
  const { rpc, tracker, requests } = connection();
  const failed = rpc.start("permission.reply", permission);
  rpc.receive({
    t: "request.result",
    ref: failed.state.ref,
    seq: 1,
    outcome: {
      ok: false,
      error: { code: "native.failed", retry: "new-intent", diagnosticID: "d" },
    },
  });
  await assertRejects(() => failed.result);
  const retry = rpc.start("permission.reply", permission);
  assertEquals(retry === failed, false);
  assertEquals(requests().length, 2);
  // A submitted mutation can still land natively, so releasing it keeps it.
  retry.release();
  assertStrictEquals(rpc.start("permission.reply", permission), retry);
  assertEquals(requests().length, 2);
  const controller = new AbortController();
  controller.abort();
  const other = { ...permission, requestID: "per_3" };
  const released = rpc.start("permission.reply", other, {
    signal: controller.signal,
  });
  assertEquals(released.state.phase, "released");
  const again = rpc.start("permission.reply", other);
  assertEquals(again === released, false);
  assertEquals(requests().length, 3);
  tracker.stop();
});

Deno.test("question and form settlement share one native input identity", async () => {
  const { rpc, tracker, requests } = connection();
  rpc.start("question.reply", { requestID: "que_1", answers: [["A"]] });
  await assertRejects(() =>
    rpc.call("question.reject", { requestID: "que_1" })
  );
  await assertRejects(() =>
    rpc.call("form.reply", { requestID: "que_1", answer: {} })
  );
  assertEquals(requests().length, 1);
  rpc.start("form.cancel", { requestID: "frm_1" });
  assertEquals(requests().length, 2);
  // Unrelated mutations keep the tracker's ordinary per-intent admission.
  rpc.start("tasks.close", { id: "task" });
  rpc.start("tasks.close", { id: "task" });
  assertEquals(requests().length, 4);
  tracker.stop();
});
