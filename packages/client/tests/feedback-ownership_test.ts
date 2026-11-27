// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals } from "@std/assert";
import { RequestFailure, Rpc } from "../mod.ts";

Deno.test("transient command surfaces defer only to a retained sink with the same failure identity", async () => {
  const rpc = new Rpc(() => {});
  rpc.requests.connect({
    id: crypto.randomUUID(),
    expiresAt: Date.now() + 60000,
  }, 64);
  const operation = rpc.start("session.rename", {
    sessionID: "tstv1-one",
    title: "A title",
  });
  const result = operation.result.catch((cause) => cause);
  const ref = operation.state.ref;
  const failure = {
    code: "session.busy",
    retry: "new-intent" as const,
    diagnosticID: "owned-diagnostic",
  };
  rpc.receive({
    t: "request.accepted",
    ref,
    seq: 1,
    acceptedAt: 1,
    retentionUntil: 2,
    replayed: false,
  });
  rpc.receive({
    t: "request.result",
    ref,
    seq: 2,
    outcome: { ok: false, error: failure },
  });
  const cause = await result;
  assertEquals(
    rpc.ownsFailure(cause),
    false,
    "An unbound target still needs its menu's local sink",
  );
  const sink = rpc.feedback("tstv1-one");
  assertEquals(rpc.ownsFailure(cause), true);
  assertEquals(sink.current()?.diagnosticID, failure.diagnosticID);
  assertEquals(rpc.ownsFailure(new Error("owned-diagnostic")), false);
  assertEquals(
    rpc.ownsFailure(
      new RequestFailure({ ...failure, diagnosticID: "unrelated" }),
    ),
    false,
  );
  rpc.requests.stop();
});

Deno.test("local pre-admission failures retain one presentation owner without a native request", () => {
  const rpc = new Rpc(() => {});
  const cause = new RequestFailure({
    code: "branch-history.storage",
    retry: "new-intent",
    diagnosticID: "local-archive",
    facts: {
      actionLabel: "Saving an earlier branch",
      target: { sessionID: "tstv1-one" },
      reason: "Storage is full",
      recovery: "Free browser storage and retry",
    },
  });
  assertEquals(rpc.ownsFailure(cause), false);
  const sink = rpc.feedback("tstv1-one");
  sink.fail(cause);
  assertEquals(
    rpc.ownsFailure(cause),
    true,
    "The installed target sink owns local admission failures too",
  );
  sink.clear();
  assertEquals(
    rpc.ownsFailure(cause),
    false,
    "A cleared sink cannot suppress a later surface",
  );
  rpc.requests.stop();
});

Deno.test("dismissing a retained notice preserves the request outcome and will not hide a newer notice", async () => {
  const rpc = new Rpc(() => {}), owner = "tstv1-one";
  rpc.requests.connect({
    id: crypto.randomUUID(),
    expiresAt: Date.now() + 60000,
  }, 64);
  const sink = rpc.feedback(owner);
  const operation = rpc.start("session.rename", {
    sessionID: owner,
    title: "A title",
  });
  const result = operation.result.catch((cause) => cause);
  assertEquals(sink.current()?.dismiss, undefined);
  rpc.receive({
    t: "request.accepted",
    ref: operation.state.ref,
    seq: 1,
    acceptedAt: 1,
    retentionUntil: 2,
    replayed: false,
  });
  rpc.receive({
    t: "request.result",
    ref: operation.state.ref,
    seq: 2,
    outcome: {
      ok: false,
      error: { code: "session.busy", retry: "none", diagnosticID: "rename" },
    },
  });
  await result;
  sink.current()!.dismiss!();
  assertEquals(sink.current(), undefined);
  assertEquals(operation.state.error?.diagnosticID, "rename");
  const reload = new Rpc(() => {});
  reload.requests.restore(JSON.parse(JSON.stringify(rpc.requests.snapshot())));
  assertEquals(reload.feedback(owner).current(), undefined);

  sink.fail({ kind: "info", text: "Restored automatically" });
  const dismiss = sink.current()!.dismiss!;
  sink.fail({ kind: "info", text: "Newer result" });
  dismiss();
  assertEquals(sink.current()?.text, "Newer result");
  sink.current()!.dismiss!();
  assertEquals(sink.current(), undefined);
  rpc.requests.stop();
  reload.requests.stop();
});

Deno.test("late bookkeeping preserves a local Send outcome until a new primary intent", async () => {
  const rpc = new Rpc(() => {}), owner = "tstv1-one";
  rpc.requests.connect({
    id: crypto.randomUUID(),
    expiresAt: Date.now() + 60000,
  }, 64);
  const sink = rpc.feedback(owner);
  sink.fail(
    new RequestFailure({
      code: "send.unconfirmed",
      diagnosticID: "send",
      retry: "none",
      facts: { reason: "The message could not be confirmed" },
    }),
  );
  const visitOperation = rpc.start("projects.visit", {
    directory: "/project",
    active: true,
  }, { owner });
  const complete = (ref: typeof visitOperation.state.ref) => {
    rpc.receive({
      t: "request.accepted",
      ref,
      seq: 1,
      acceptedAt: Date.now(),
      retentionUntil: Date.now() + 60000,
      replayed: false,
    });
    rpc.receive({
      t: "request.result",
      ref,
      seq: 2,
      outcome: { ok: true, result: null },
    });
  };
  const visit = visitOperation.result;
  complete(visitOperation.state.ref);
  try {
    assertEquals(
      sink.current()?.failure?.reason,
      "The message could not be confirmed",
    );
    const renameOperation = rpc.start("session.rename", {
      sessionID: owner,
      title: "Next intent",
    }, { owner });
    const rename = renameOperation.result;
    complete(renameOperation.state.ref);
    assertEquals(sink.current()?.failure, undefined);
    rpc.requests.stop();
    await rename;
  } finally {
    rpc.requests.stop();
    await visit;
  }
});
