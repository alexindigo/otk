// SPDX-License-Identifier: LGPL-3.0-only
import {
  assertEquals,
  assertRejects,
  assertStrictEquals,
  assertThrows,
} from "@std/assert";
import {
  RequestFailure,
  RequestLifetimes,
  RequestTracker,
  Rpc,
} from "../mod.ts";
import type { RequestControl } from "@otk/protocol";

function connection(terminal?: "succeeded" | "failed") {
  const sent: RequestControl[] = [];
  const tracker = new RequestTracker({
    send: (frame) => {
      sent.push(frame);
      if (frame.t === "request" && terminal) {
        rpc.receive({
          t: "request.result",
          ref: frame.ref,
          seq: 1,
          outcome: terminal === "succeeded" ? { ok: true, result: null } : {
            ok: false,
            error: {
              code: "native.failed",
              retry: "new-intent",
              diagnosticID: "synchronous",
            },
          },
        });
      }
    },
  });
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

Deno.test("conflict feedback during reserved cleanup observes the captured target without admitting native work", async () => {
  const { rpc, tracker, requests } = connection();
  const captured = { ...permission, sessionID: "tstv1-original" };
  let armed = true, conflict: unknown;
  const cleanup = new Error("cleanup failed before admission");
  const stop = rpc.feedback(captured.sessionID).subscribe(() => {
    if (!armed) return;
    armed = false;
    try {
      rpc.start("permission.reply", {
        ...permission,
        sessionID: "tstv1-other",
        reply: "reject",
      });
    } catch (cause) {
      conflict = cause;
    }
    throw cleanup;
  });
  try {
    assertStrictEquals(
      assertThrows(() => rpc.start("permission.reply", captured)),
      cleanup,
    );
    assertEquals(
      conflict instanceof RequestFailure ? conflict.failure.code : undefined,
      "request.conflict",
    );
    assertEquals(
      conflict instanceof RequestFailure
        ? conflict.failure.facts?.target?.sessionID
        : undefined,
      captured.sessionID,
    );
    assertEquals(
      requests().length,
      0,
      "declined feedback cannot initialize the lazy admission getter",
    );
    assertEquals(tracker.operations().length, 0);
    const retry = rpc.start("permission.reply", captured);
    assertEquals(requests().length, 1);
    rpc.receive({
      t: "request.result",
      ref: retry.state.ref,
      seq: 1,
      outcome: { ok: true, result: null },
    });
    assertEquals(await retry.result, null);
  } finally {
    stop();
    tracker.stop();
  }
});

for (const admitted of [false, true]) {
  Deno.test(`throwing cleanup admitted=${admitted} cannot lose a real settlement or retain an uninitialized reservation`, async () => {
    const { rpc, tracker, requests } = connection();
    let armed = true, joined: ReturnType<typeof rpc.start> | undefined;
    const cleanup = new Error("cleanup failed");
    const stop = rpc.feedback("s").subscribe(() => {
      if (!armed) return;
      armed = false;
      if (admitted) joined = rpc.start("permission.reply", permission);
      throw cleanup;
    });
    try {
      assertStrictEquals(
        assertThrows(() => rpc.start("permission.reply", permission)),
        cleanup,
      );
      const retry = rpc.start("permission.reply", permission);
      if (admitted) assertStrictEquals(retry, joined);
      assertEquals(
        requests().length,
        1,
        "cleanup failure cannot admit the same native request twice",
      );
      rpc.receive({
        t: "request.result",
        ref: retry.state.ref,
        seq: 1,
        outcome: { ok: true, result: null },
      });
      assertEquals(await retry.result, null);
    } finally {
      stop();
      tracker.stop();
    }
  });
}

for (const terminal of ["released", "succeeded", "failed"] as const) {
  Deno.test(`native settlement reentry joins its real operation during synchronous ${terminal} initialization`, async () => {
    const { rpc, tracker, requests } = connection(
      terminal === "released" ? undefined : terminal,
    );
    let joined: ReturnType<typeof rpc.start> | undefined, entered = false;
    const stop = tracker.subscribe(() => {
      if (entered) return;
      entered = true;
      joined = rpc.start("permission.reply", permission);
    });
    const controller = new AbortController();
    if (terminal === "released") controller.abort();
    try {
      const first = rpc.start("permission.reply", permission, {
        signal: controller.signal,
      });
      assertEquals(entered, true);
      assertStrictEquals(joined, first);
      assertEquals(first.state.phase, terminal);
      assertEquals(requests().length, terminal === "released" ? 0 : 1);
      if (terminal === "succeeded") {
        assertEquals(await first.result, null);
        assertStrictEquals(rpc.start("permission.reply", permission), first);
        assertEquals(requests().length, 1);
      } else {
        await assertRejects(() => first.result);
        const retry = rpc.start("permission.reply", permission);
        assertEquals(retry === first, false);
        assertEquals(requests().length, terminal === "released" ? 1 : 2);
        if (terminal === "failed") await assertRejects(() => retry.result);
      }
    } finally {
      stop();
      tracker.stop();
    }
  });
}

for (const boundary of ["tracker publication", "failure cleanup"] as const) {
  Deno.test(`native settlement reserves its operation and captured intent before ${boundary} reentry`, async () => {
    const { rpc, tracker, requests } = connection();
    let stop = () => {}, entered = false;
    let joined: ReturnType<typeof rpc.start> | undefined, conflict: unknown;
    try {
      if (boundary === "failure cleanup") {
        const failed = rpc.start("permission.reply", permission);
        rpc.receive({
          t: "request.result",
          ref: failed.state.ref,
          seq: 1,
          outcome: {
            ok: false,
            error: {
              code: "native.failed",
              retry: "new-intent",
              diagnosticID: "prior",
            },
          },
        });
        await assertRejects(() => failed.result);
      }
      const feedback = rpc.feedback("s"), before = requests().length;
      if (boundary === "failure cleanup") {
        assertEquals(feedback.current()?.kind, "error");
      }
      const intent = rpc.intent();
      const reenter = () => {
        if (entered) return;
        entered = true;
        joined = rpc.start("permission.reply", { ...permission });
        try {
          rpc.start("permission.reply", { ...permission, reply: "reject" });
        } catch (cause) {
          conflict = cause;
        }
      };
      stop = boundary === "tracker publication"
        ? tracker.subscribe(reenter)
        : feedback.subscribe(reenter);
      const first = rpc.start("permission.reply", permission, { intent });
      assertEquals(entered, true);
      assertStrictEquals(joined, first);
      assertEquals(
        first.state.ref.key,
        intent.key,
        "cleanup cannot replace the caller's captured intent",
      );
      assertEquals(requests().length, before + 1);
      assertEquals(requests().at(-1)!.params, permission);
      assertEquals(
        conflict instanceof RequestFailure ? conflict.failure.code : undefined,
        "request.conflict",
      );
      rpc.receive({
        t: "request.result",
        ref: first.state.ref,
        seq: 1,
        outcome: { ok: true, result: null },
      });
      assertEquals(await first.result, null);
      assertStrictEquals(rpc.start("permission.reply", permission), first);
      assertEquals(requests().length, before + 1);
    } finally {
      stop();
      tracker.stop();
    }
  });
}

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

Deno.test("one question projection follows its exact operation and native settlement", async () => {
  const { rpc, tracker, requests } = connection();
  const authority = new RequestLifetimes();
  const request = { id: "q", sessionID: "s", questions: [] };
  authority.receive({ op: "question.upsert", request });
  const observed: (string | undefined)[] = [];
  const stop = tracker.subscribe(() => {
    observed.push(rpc.questionResponse("q", authority)?.state);
  });
  const first = rpc.start("question.reply", {
    requestID: "q",
    answers: [["A"]],
  }, { owner: "s" });
  assertEquals(
    rpc.feedback("s").current(),
    undefined,
    "Question feedback must not appear on the session composer",
  );
  assertEquals(rpc.questionResponse("q", authority)?.state, "sending");
  assertEquals(observed.at(-1), "sending");
  assertEquals(rpc.questionResponse("q", authority)?.answers, [["A"]]);
  assertEquals(rpc.questionResponse("unrelated", authority), undefined);
  const failure = {
    code: "native.failed",
    retry: "new-intent",
    diagnosticID: "answer-failure",
  } as const;
  rpc.receive({
    t: "request.result",
    ref: requests()[0].ref,
    seq: 1,
    outcome: { ok: false, error: failure },
  });
  await assertRejects(() => first.result, RequestFailure);
  assertEquals(rpc.questionResponse("q", authority)?.state, "failed");
  assertEquals(rpc.questionResponse("q", authority)?.canResend, true);
  assertEquals(
    rpc.questionResponse("q", authority)?.feedback?.diagnosticID,
    failure.diagnosticID,
  );
  assertEquals(rpc.feedback("s").current(), undefined);
  const retry = rpc.start("question.reply", {
    requestID: "q",
    answers: [["A"]],
  }, { owner: "s" });
  assertEquals(requests().length, 2);
  assertEquals(rpc.questionResponse("q", authority)?.state, "sending");
  authority.receive({ op: "question.remove", requestID: "q", sessionID: "s" });
  assertEquals(rpc.questionResponse("q", authority), { state: "confirmed" });
  rpc.receive({
    t: "request.result",
    ref: requests()[1].ref,
    seq: 1,
    outcome: { ok: true, result: null },
  });
  await retry.result;
  assertEquals(rpc.questionResponse("q", authority), { state: "confirmed" });
  stop();
  tracker.stop();
});
