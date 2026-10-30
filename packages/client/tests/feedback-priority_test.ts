// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals } from "@std/assert";
import { Rpc } from "../mod.ts";

Deno.test("target feedback keeps a user action ahead of later seen and visit bookkeeping", () => {
  const rpc = new Rpc(() => {});
  rpc.requests.connect({
    id: crypto.randomUUID(),
    expiresAt: Date.now() + 60000,
  }, 64);
  const sink = rpc.feedback("tstv1-one");
  const reply = rpc.start("permission.reply", {
    sessionID: "tstv1-one",
    requestID: "request",
    reply: "once",
  });
  void reply.result.catch(() => {});
  const seen = rpc.start("sessions.seen", { sessionID: "tstv1-one" });
  void seen.result.catch(() => {});
  assertEquals(sink.current()?.text, "Sending response");
  const ref = reply.state.ref;
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
    outcome: {
      ok: false,
      error: {
        code: "session.busy",
        retry: "new-intent",
        diagnosticID: "reply-failure",
      },
    },
  });
  assertEquals(sink.current()?.diagnosticID, "reply-failure");
  rpc.requests.stop();
});
