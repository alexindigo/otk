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
