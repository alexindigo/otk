// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals, assertRejects } from "@std/assert";
import type { RequestControl } from "@otk/protocol";
import { RequestFailure, RequestTracker } from "@otk/client";

Deno.test("fresh server authority is not invalidated by the client's wall clock", () => {
  const sent: RequestControl[] = [];
  let renewals = 0;
  const tracker = new RequestTracker({
    send: (frame) => sent.push(frame),
    kind: () => "read",
    renewWindow: () => {
      renewals++;
      tracker.connect(
        { id: "fresh-window", expiresAt: Date.now() + 100000 },
        8,
      );
    },
  });
  // Absolute expiry belongs to the server clock. The browser may be ahead.
  tracker.connect({ id: "server-window", expiresAt: Date.now() - 1 }, 8);
  const operation = tracker.capture("session.get", {
    sessionID: "opcv2-ses_window",
  });
  assertEquals(renewals, 0);
  assertEquals(operation.state.ref.window, "server-window");
  assertEquals(
    sent.filter((frame) => frame.t === "request").map((frame) =>
      frame.ref.window
    ),
    ["server-window"],
  );
  tracker.stop();
});

Deno.test("an expired read rejection renews the serving connection once and settles its original promise", async () => {
  const sent: RequestControl[] = [];
  let renewals = 0;
  const tracker = new RequestTracker({
    send: (frame) => sent.push(frame),
    kind: () => "read",
    renewWindow: () => {
      renewals++;
      tracker.disconnect();
      tracker.connect(
        { id: "fresh-window", expiresAt: Date.now() + 100000 },
        8,
      );
    },
  });
  tracker.connect({ id: "old-window", expiresAt: Date.now() + 100000 }, 8);
  const operation = tracker.capture("session.get", {
    sessionID: "opcv2-ses_window",
  });
  tracker.receive({
    t: "request.rejected",
    ref: operation.state.ref,
    error: {
      code: "request.expired",
      retry: "none",
      diagnosticID: "expired-on-server",
    },
  });
  assertEquals(renewals, 1);
  assertEquals(operation.state.ref.window, "fresh-window");
  tracker.receive({
    t: "request.result",
    ref: operation.state.ref,
    seq: 1,
    outcome: { ok: true, result: "fresh result" },
  });
  assertEquals(await operation.result, "fresh result");
  assertEquals(sent.filter((frame) => frame.t === "request").length, 2);
  tracker.stop();
});

Deno.test("new captures during disconnect wait for the next welcome window", () => {
  const sent: RequestControl[] = [];
  const tracker = new RequestTracker({
    send: (frame) => sent.push(frame),
    kind: () => "read",
  });
  tracker.connect({ id: "old-window", expiresAt: Date.now() + 100000 }, 8);
  tracker.disconnect();
  const read = tracker.start("session.get", { sessionID: "opcv2-ses_window" });
  assertEquals(read.state.ref.window, "");
  tracker.connect({ id: "fresh-window", expiresAt: Date.now() + 100000 }, 8);
  assertEquals(read.state.ref.window, "fresh-window");
  tracker.stop();
});

Deno.test("a disconnected unsent capture cannot move to another principal's welcome", () => {
  const sent: RequestControl[] = [];
  const tracker = new RequestTracker({
    send: (frame) => sent.push(frame),
    kind: () => "mutation",
  });
  tracker.connect(
    { id: "first-window", expiresAt: Date.now() + 100000 },
    8,
    "first-user",
  );
  tracker.disconnect();
  const operation = tracker.capture("session.prompt", {
    sessionID: "opcv2-ses_window",
  });
  tracker.connect(
    { id: "other-window", expiresAt: Date.now() + 100000 },
    8,
    "other-user",
  );
  assertEquals(operation.state.connection, "authentication-required");
  assertEquals(operation.state.ref.window, "");
  assertEquals(
    sent.filter((frame) =>
      frame.t === "request" || frame.t === "request.resume"
    ).length,
    0,
  );
  tracker.stop();
});

Deno.test("expired idempotent read renews once under current welcome; old frames cannot settle it", async () => {
  const sent: RequestControl[] = [];
  const tracker = new RequestTracker({
    send: (frame) => sent.push(frame),
    kind: () => "read",
  });
  tracker.connect({ id: "old-window", expiresAt: Date.now() + 100000 }, 8);
  const read = tracker.start("session.get", { sessionID: "opcv2-ses_window" });
  const old = read.state.ref;
  tracker.disconnect();
  tracker.connect({ id: "fresh-window", expiresAt: Date.now() + 100000 }, 8);
  tracker.receive({
    t: "request.rejected",
    ref: old,
    error: {
      code: "request.expired",
      retry: "none",
      diagnosticID: "old-admission",
    },
  });
  assertEquals(read.state.ref.window, "fresh-window");
  assertEquals(sent.at(-1)?.t, "request");
  tracker.receive({
    t: "request.result",
    ref: old,
    seq: 1,
    outcome: { ok: true, result: "obsolete" },
  });
  assertEquals(read.state.phase, "sending");
  const failure = assertRejects(() => read.result, RequestFailure);
  tracker.receive({
    t: "request.rejected",
    ref: read.state.ref,
    error: {
      code: "request.expired",
      retry: "none",
      diagnosticID: "fresh-admission",
    },
  });
  await failure;
  assertEquals(sent.filter((frame) => frame.t === "request").length, 2);
  tracker.stop();
});

Deno.test("expired native send is never resubmitted under a new window", async () => {
  const sent: RequestControl[] = [];
  const tracker = new RequestTracker({
    send: (frame) => sent.push(frame),
    kind: () => "mutation",
  });
  tracker.connect({ id: "old-window", expiresAt: Date.now() + 100000 }, 8);
  const send = tracker.start("session.prompt", {
    sessionID: "opcv2-ses_window",
    mode: "normal",
    parts: [{ kind: "text", text: "one captured prompt" }],
  });
  tracker.disconnect();
  tracker.connect({ id: "fresh-window", expiresAt: Date.now() + 100000 }, 8);
  const failure = assertRejects(() => send.result, RequestFailure);
  tracker.receive({
    t: "request.rejected",
    ref: send.state.ref,
    error: {
      code: "request.expired",
      retry: "none",
      diagnosticID: "native-admission",
      facts: {
        reason: "Request window expired after OTK restarted",
        recovery: "Check opencode before sending again",
      },
    },
  });
  await failure;
  assertEquals(sent.filter((frame) => frame.t === "request").length, 1);
  assertEquals(
    send.state.error?.facts?.reason,
    "Request window expired after OTK restarted",
  );
  tracker.stop();
});
