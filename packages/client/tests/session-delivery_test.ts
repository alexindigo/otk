// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals, assertRejects } from "@std/assert";
import {
  createSessionDelivery,
  SEND_OBSERVATION_MS,
} from "../session-delivery.ts";
import { createTranscriptProjection } from "../transcript-projection.ts";
import type { TranscriptOwner } from "../transcript.ts";
import type { PromptReceipt, UserMessage } from "@otk/protocol";
import { RequestFailure } from "../failures.ts";
import { pendingMessage } from "../pending-send.ts";

function fixture() {
  const projection = createTranscriptProjection();
  const listeners = new Set<() => void>(),
    timers = new Map<number, () => void>();
  let serial = 0, reads = 0, pins = 0;
  const transcript = {
    projection,
    send(value: import("../pending-send.ts").PendingSend) {
      projection.send(value);
      for (const listener of listeners) listener();
    },
    state: { clock: { epoch: "content", seq: 2 } },
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    pin() {
      pins++;
      return () => {
        pins--;
      };
    },
    refetch() {
      reads++;
      return Promise.resolve();
    },
    reconcile() {
      reads++;
      return Promise.resolve();
    },
  } as unknown as TranscriptOwner;
  const owner = createSessionDelivery({
    target: { sidecarId: "server", sessionID: "opcv2-root" },
    title: () => "Captured session",
    transcript: () => transcript,
    clock: {
      set(run, ms) {
        assertEquals(ms, SEND_OBSERVATION_MS);
        timers.set(++serial, run);
        return serial;
      },
      clear(id) {
        timers.delete(id as number);
      },
    },
  });
  return {
    owner,
    projection,
    message(id: string) {
      const message: UserMessage = {
        id,
        sessionID: "opcv2-root",
        role: "user",
        time: { created: 1 },
        parts: [],
      };
      projection.merge([message]);
      for (const listener of listeners) listener();
    },
    expire() {
      for (const [id, run] of timers) {
        timers.delete(id);
        run();
      }
    },
    counts: () => ({
      reads,
      pins,
      timers: timers.size,
      listeners: listeners.size,
    }),
  };
}

Deno.test("accepted send is not admitted or presented by RPC success, deadline or another identity", async () => {
  const f = fixture();
  let sends = 0;
  await f.owner.send(() => {
    sends++;
    return Promise.resolve({ messageID: "sent", state: "queued" });
  });
  assertEquals(f.owner.state.receipts[0].phase, "queued");
  assertEquals(f.counts().reads, 1);
  f.owner.presented(["other"]);
  f.expire();
  const failed = f.owner.state.receipts[0].feedback;
  assert(failed?.failure);
  assertEquals(failed.failure.target, { label: "" });
  assert(failed.failure.reason.includes("not been observed"));
  assert(failed.failure.recovery?.includes("Do not send it again"));
  await f.owner.reload();
  assertEquals(sends, 1);
  f.message("sent");
  assertEquals(f.owner.state.receipts[0].phase, "admitted");
  assertEquals(f.owner.state.receipts[0].feedback, undefined);
  f.owner.presented(["sent"]);
  assertEquals(f.owner.state.receipts, []);
  assertEquals(f.owner.state.last?.phase, "presented");
  assertEquals(f.owner.state.last?.clock, { epoch: "content", seq: 2 });
  f.owner.stop();
  assertEquals(f.counts(), { reads: 2, pins: 0, timers: 0, listeners: 0 });
});

Deno.test("presentation before native result joins the same identity without a receipt leak", async () => {
  const f = fixture(), accepted = Promise.withResolvers<PromptReceipt>();
  const pending = f.owner.send(() => accepted.promise);
  assertEquals(f.owner.state.receipts[0].phase, "submitted");
  f.message("fast");
  f.owner.presented(["fast"]);
  assertEquals(f.owner.state.receipts[0].phase, "submitted");
  accepted.resolve({ messageID: "fast", state: "accepted" });
  await pending;
  assertEquals(f.owner.state.receipts, []);
  assertEquals(f.counts().timers, 0);
  assertEquals(f.counts().pins, 0);
  f.owner.stop();
});

Deno.test("admission without presentation retains an actionable observation failure until real source visibility", async () => {
  const f = fixture();
  f.message("offscreen");
  await f.owner.send(() =>
    Promise.resolve({ messageID: "offscreen", state: "accepted" })
  );
  assertEquals(f.owner.state.receipts[0].phase, "admitted");
  f.expire();
  assert(
    f.owner.state.receipts[0].feedback?.failure?.reason.includes(
      "presentation",
    ),
  );
  f.message("unrelated");
  assert(f.owner.state.receipts[0].feedback);
  f.owner.presented(["offscreen"]);
  assertEquals(f.owner.state.receipts.length, 0);
  f.owner.stop();
});

Deno.test("rejected native send leaves failure and draft settlement to the requesting operation", async () => {
  const f = fixture();
  await assertRejects(
    () => f.owner.send(() => Promise.reject(new Error("rejected"))),
    Error,
    "rejected",
  );
  assertEquals(f.owner.state.receipts, []);
  assertEquals(f.counts().reads, 0);
  assertEquals(f.owner.state.follow, 1);
  f.owner.stop();
});

Deno.test("pending input is visible before acknowledgement and commits by identity before result", async () => {
  const f = fixture(), acknowledgement = Promise.withResolvers<PromptReceipt>();
  const entry = {
    intent: { clientID: "tab", key: "send-key", window: "window" },
    message: pendingMessage("msg_local", "opcv2-root", [{
      kind: "text",
      text: "Sent now",
    }]),
    phase: "pending" as const,
  };
  const sending = f.owner.send(() => acknowledgement.promise, entry);
  let duplicates = 0;
  await f.owner.send(() => {
    duplicates++;
    return Promise.resolve(null);
  }, entry);
  assertEquals(duplicates, 0);
  assertEquals(f.projection.state.replyIDs, ["send-key"]);
  assertEquals(f.projection.entry("msg_local")?.send?.phase, "pending");
  assertEquals(f.owner.state.receipts[0].phase, "submitted");
  f.projection.replace([]); // reconnect/server restart replacement
  assertEquals(f.projection.state.replyIDs, ["send-key"]);
  f.message("msg_local");
  f.owner.presented(["msg_local"]);
  assertEquals(
    f.projection.entry("msg_local")?.send?.phase,
    "committed",
  );
  acknowledgement.resolve({ messageID: "msg_local", state: "accepted" });
  await sending;
  await f.owner.send(() => {
    duplicates++;
    return Promise.resolve(null);
  }, entry);
  assertEquals(duplicates, 0);
  assertEquals(f.projection.state.replyIDs, ["send-key"]);
  assertEquals(f.owner.state.receipts, []);
  f.owner.stop();
});

Deno.test("unacknowledged send has bounded visible failure; Retry observes without another mutation", async () => {
  const f = fixture(), acknowledgement = Promise.withResolvers<PromptReceipt>();
  let sends = 0;
  const sending = f.owner.send(() => {
    sends++;
    return acknowledgement.promise;
  }, {
    intent: { clientID: "tab", key: "send-key", window: "window" },
    message: pendingMessage("msg_timeout", "opcv2-root", [{
      kind: "text",
      text: "Keep me",
    }]),
    phase: "pending",
  });
  f.expire();
  const entry = f.projection.entry("msg_timeout")!.send!;
  assertEquals(entry.phase, "failed");
  assert(entry.feedback?.failure?.reason.includes("ten seconds"));
  assertEquals(
    entry.feedback?.failure?.heading,
    "Checking whether sending prompt finished",
  );
  assertEquals(entry.feedback?.failure?.target, { label: "" });
  assertEquals(entry.feedback?.kind, "pending");
  entry.feedback?.action?.run();
  assertEquals(
    f.projection.entry("msg_timeout")?.send?.phase,
    "pending",
  );
  assertEquals(sends, 1);
  f.message("msg_timeout");
  acknowledgement.resolve({ messageID: "msg_timeout", state: "queued" });
  await sending;
  f.owner.stop();
});

Deno.test("a local pending body cannot satisfy native admission or suppress read-only recovery", async () => {
  const f = fixture();
  await f.owner.send(
    () => Promise.resolve({ messageID: "msg_pending", state: "accepted" }),
    {
      intent: { clientID: "tab", key: "send-key", window: "window" },
      message: pendingMessage("msg_pending", "opcv2-root", [{
        kind: "text",
        text: "Native source still missing",
      }]),
      phase: "pending",
    },
  );
  assertEquals(f.counts().reads, 1);
  assertEquals(f.owner.state.receipts[0].phase, "accepted");
  f.message("different-native-identity");
  assertEquals(f.projection.committed("msg_pending"), false);
  f.expire();
  assertEquals(f.projection.entry("msg_pending")?.send?.phase, "failed");
  f.owner.stop();
});

Deno.test("definite failure retains the prompt and Retry action in that same entry", async () => {
  const f = fixture();
  let retries = 0;
  await assertRejects(() =>
    f.owner.send(() =>
      Promise.reject(
        new RequestFailure({
          code: "native.refused",
          retry: "new-intent",
          diagnosticID: "refused",
          facts: {
            reason: "The selected model is unavailable.",
            origin: "composer",
            record: { messageID: "native-failure" },
          },
        }),
      ), {
      intent: { clientID: "tab", key: "send-key", window: "window" },
      message: pendingMessage("msg_failure", "opcv2-root", [{
        kind: "text",
        text: "Retained",
      }]),
      phase: "pending",
      retry: () => {
        retries++;
      },
    })
  );
  const entry = f.projection.entry("msg_failure")!.send!;
  assertEquals(entry.phase, "failed");
  assert(entry.feedback?.failure?.reason.includes("selected model"));
  assertEquals(entry.feedback?.failure?.reference, undefined);
  assertEquals(entry.feedback?.failure?.heading, "Sending prompt failed");
  assertEquals(entry.feedback?.failure?.target, { label: "" });
  entry.feedback?.action?.run();
  assertEquals(retries, 1);
  assertEquals(f.projection.state.replyIDs, ["send-key"]);
  f.owner.stop();
});
