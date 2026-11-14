// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals, assertRejects, assertStrictEquals } from "@std/assert";
import { RequestFailure, RequestTracker, Rpc } from "@otk/client";
import type { RequestControl } from "@otk/protocol";

const sessionID = "tstv1-reply_target";
function connection() {
  const sent: RequestControl[] = [];
  const tracker = new RequestTracker({
    send: (frame) => sent.push(frame),
    sidecarId: "remote",
    sessionTitle: (id) => id === sessionID ? "Reply target" : undefined,
  });
  tracker.connect(
    { id: crypto.randomUUID(), expiresAt: Date.now() + 10000 },
    4,
  );
  const rpc = new Rpc(() => {}, tracker);
  return { rpc, tracker, sent };
}

for (const kind of ["permission", "question", "form"] as const) {
  Deno.test(`${kind} admission conflicts retain action, title and reason without another reply`, async () => {
    const { rpc, tracker, sent } = connection();
    const options = {
      owner: "tstv1-parent",
      facts: { target: { sessionID } },
    };
    const owner = rpc.feedback(options.owner);
    const original = () =>
      kind === "permission"
        ? rpc.start("permission.reply", {
          sessionID,
          requestID: "native-request",
          reply: "once",
        }, options)
        : kind === "question"
        ? rpc.start("question.reply", {
          requestID: "native-request",
          answers: [["A"]],
        }, options)
        : rpc.start("form.reply", {
          requestID: "native-request",
          answer: { choice: "A" },
        }, options);
    try {
      const admitted = original();
      assertStrictEquals(original(), admitted);
      const otherView = {
        ...options,
        facts: {
          target: { sessionID: "tstv1-other", label: "Different view" },
        },
      };
      const failure = await assertRejects(
        () =>
          kind === "permission"
            ? rpc.call("permission.reply", {
              sessionID,
              requestID: "native-request",
              reply: "reject",
            }, otherView)
            : kind === "question"
            ? rpc.call("question.reply", {
              requestID: "native-request",
              answers: [["B"]],
            }, otherView)
            : rpc.call("form.reply", {
              requestID: "native-request",
              answer: { choice: "B" },
            }, otherView),
        RequestFailure,
      );
      assertEquals(failure.failure.code, "request.conflict");
      assertEquals(failure.failure.facts?.action, `${kind}.reply`);
      assertEquals(failure.failure.facts?.target, {
        sidecarId: "remote",
        sessionID,
        label: "Reply target",
      });
      assertEquals(
        failure.failure.facts?.reason,
        "A different response was already sent for this request",
      );
      assertEquals(failure.failure.facts?.recovery, "This one was not sent");
      owner.fail(failure);
      const feedback = owner.current()!;
      assertEquals(feedback.kind, "error");
      assertEquals(feedback.failure?.target, {
        label: "Reply target",
        href: `#/remote/${sessionID}`,
      });
      assertEquals(
        feedback.failure?.value.diagnosticID,
        failure.failure.diagnosticID,
      );
      assertEquals(sent.filter((frame) => frame.t === "request").length, 1);
      assertEquals(admitted.state.phase, "sending");
      owner.clear();
      assertEquals(owner.current()?.kind, "pending");
    } finally {
      tracker.stop();
    }
  });
}

Deno.test("new local failure stays visible without settling older owned work", () => {
  const { rpc, tracker } = connection();
  try {
    const owner = rpc.feedback(sessionID);
    const operation = rpc.start("permission.reply", {
      sessionID,
      requestID: "pending-request",
      reply: "once",
    });
    owner.fail(
      new RequestFailure({
        code: "request.conflict",
        retry: "none",
        diagnosticID: "local-conflict",
        facts: {
          action: "permission.reply",
          target: { sessionID, label: "Reply target" },
          reason: "A different response was already sent for this request",
        },
      }),
    );
    assertEquals(owner.current()?.kind, "error");
    assertEquals(operation.state.phase, "sending");
    owner.clear();
    assertEquals(owner.current()?.kind, "pending");
  } finally {
    tracker.stop();
  }
});
