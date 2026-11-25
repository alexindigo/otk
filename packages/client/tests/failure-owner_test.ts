// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals } from "@std/assert";
import {
  createFailurePresenter,
  failureValue,
  RequestFailure,
  RequestTracker,
  Rpc,
} from "../mod.ts";
import type { IndexMetadata, PublicFailure } from "@otk/protocol";

function failure(id: string, sessionID = "tstv1-first"): PublicFailure {
  return {
    code: "invented.new-code",
    diagnosticID: id,
    retry: "none",
    facts: {
      action: "session.rename",
      target: { sidecarId: "remote", sessionID, label: "Fixture session" },
      reason: "The session was not found",
      status: 404,
      recovery: "Open the session list to choose another session",
    },
  };
}

Deno.test("failure owner groups all occurrences, not replay or rendering, by session", () => {
  const owner = createFailurePresenter();
  let value = owner.present(failure("first"));
  for (let n = 1; n < 22; n++) {
    value = owner.present(failure(`occurrence-${n}`));
  }
  assertEquals(value.failure?.count, 22);
  assertEquals(value.failure?.occurrences.length, 22);
  assertEquals(owner.present(failure("first")).failure?.count, 22);
  assertEquals(
    owner.present(failure("other", "tstv1-second")).failure?.count,
    1,
  );
  assertEquals(value.failure?.target, { label: "" });
  assertEquals(value.failure?.value.facts?.target?.label, "Fixture session");
  for (
    const fact of [
      "Renaming session",
      "not found",
      "404",
      "choose another",
    ]
  ) assert(value.text.includes(fact), fact);
  const changed = failure("changed");
  changed.facts!.recovery = "Choose another title";
  assertEquals(owner.present(changed).failure?.count, 1);
  changed.facts!.action = "session.delete";
  assertEquals(owner.present(changed).failure?.count, 1);
});

Deno.test("tracker failures carry action and routing through both transports, without becoming attention", async () => {
  const tracker = new RequestTracker({ send() {}, sidecarId: "remote" });
  const rpc = new Rpc(() => {}, tracker);
  tracker.connect(
    { id: crypto.randomUUID(), expiresAt: Date.now() + 60000 },
    16,
  );
  const session: IndexMetadata = {
    id: "tstv1-first",
    directory: "/project",
    projectID: "project",
    title: "Fixture session",
    status: "idle",
    archived: false,
    timeCreated: 1,
    timeUpdated: 1,
    attention: {
      permissions: 0,
      questions: 0,
      childPermissions: 0,
      childQuestions: 0,
    },
  };
  try {
    for (const kind of ["request.rejected", "request.result"] as const) {
      const op = rpc.start("session.rename", {
        sessionID: session.id,
        title: "New title",
      });
      const result = op.result.catch((cause: unknown) => cause);
      const error: PublicFailure = {
        code: "invented.code",
        retry: "none",
        diagnosticID: crypto.randomUUID(),
        facts: { reason: "The selected title is unavailable" },
      };
      tracker.receive(
        kind === "request.rejected" ? { t: kind, ref: op.state.ref, error } : {
          t: kind,
          ref: op.state.ref,
          seq: 1,
          outcome: { ok: false, error },
        },
      );
      const cause = await result;
      assert(cause instanceof RequestFailure);
      assertEquals(cause.failure.facts?.action, "session.rename");
      assertEquals(cause.failure.facts?.target, {
        sidecarId: "remote",
        sessionID: session.id,
      });
      const shown = failureValue(cause);
      assert(shown);
      assertEquals(shown.failure?.target, { label: "" });
      assertEquals(
        createFailurePresenter().present(cause.failure, {
          surface: "notification",
        }).failure?.target.href,
        "#/remote/tstv1-first",
      );
      assertEquals(op.state.phase, "failed");
    }
  } finally {
    tracker.stop();
  }
});

Deno.test("unknown and unavailable outcomes remain nonterminal in every failure presentation", () => {
  const owner = createFailurePresenter();
  for (const outcome of ["unknown", "unavailable"] as const) {
    const value = failure(outcome);
    value.facts!.outcome = outcome;
    delete value.facts!.recovery;
    const shown = owner.present(value);
    assertEquals(shown.kind, "pending");
    assert(!shown.text.includes(" failed"));
    assertEquals(shown.failure?.recovery, undefined);
    assert(!shown.text.includes("will not repeat"));
  }
});
