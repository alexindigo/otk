// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals } from "@std/assert";
import {
  createSessionDelivery,
  SEND_OBSERVATION_MS,
} from "../session-delivery.ts";
import { createTranscriptProjection } from "../transcript-projection.ts";
import type { TranscriptOwner } from "../transcript.ts";
import type { PromptReceipt, UserMessage } from "@otk/protocol";
import { RequestFailure } from "../failures.ts";
import { pendingMessage } from "../pending-send.ts";
import type { SendOutcome } from "../send-outcome.ts";
import { createDrafts, type Draft } from "../drafts.ts";
import { createSessionSubmission } from "../session-submission.ts";

function fixture(committed?: (message: UserMessage) => void) {
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
    cancelSend(messageID: string) {
      projection.cancelSend(messageID);
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
    committed,
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
    message(id: string, model?: UserMessage["model"]) {
      const message: UserMessage = {
        id,
        sessionID: "opcv2-root",
        role: "user",
        time: { created: 1 },
        parts: [],
        ...(model ? { model } : {}),
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

for (const outcome of ["rejected", "unobserved", "preparing"] as const) {
  Deno.test(`reload reattaches ${outcome} input to the existing send lifecycle`, async () => {
    const f = fixture();
    const entry = {
      intent: { clientID: "tab", key: "restored" },
      message: pendingMessage("restored-message", "opcv2-root", [{
        kind: "text",
        text: "Keep these original bytes",
      }]),
      phase: "pending" as const,
      dispatched: outcome !== "preparing",
    };
    f.projection.send(entry);
    const result = Promise.withResolvers<PromptReceipt | null>();
    void result.promise.catch(() => {});
    const resume = (f.owner as typeof f.owner & {
      resume?(
        value: typeof entry,
        result?: Promise<PromptReceipt | null>,
      ): void;
    }).resume;
    resume?.(entry, outcome === "preparing" ? undefined : result.promise);
    if (outcome === "rejected") {
      result.reject(
        new RequestFailure({
          code: "native.rejected",
          retry: "new-intent",
          diagnosticID: "restored-rejection",
          facts: { reason: "Native refused the original send" },
        }),
      );
      for (let n = 0; n < 10; n++) await Promise.resolve();
    } else if (outcome === "unobserved") f.expire();
    const restored = f.projection.entry(entry.message.id)?.send;
    assertEquals(restored?.phase, "failed");
    assertEquals(restored?.message.parts, entry.message.parts);
    assert(restored?.feedback?.failure);
    if (outcome === "preparing") {
      assert(
        restored.feedback.failure.reason.includes(
          "before this message was sent",
        ),
      );
    } else if (outcome === "rejected") {
      assertEquals(
        restored.feedback.failure.reason,
        "Native refused the original send",
      );
    } else {
      assert(restored.feedback.failure.reason.includes("not been observed"));
      restored.retry?.();
      assertEquals(f.counts().reads, 1);
    }
    f.message(entry.message.id);
    assertEquals(
      f.projection.entry(entry.message.id)?.send?.phase,
      "committed",
    );
    result.resolve({ messageID: entry.message.id, state: "accepted" });
    await Promise.resolve();
    f.owner.stop();
  });
}

Deno.test("send custody sees live commitment while the dispatch promise is held", async () => {
  const f = fixture();
  const reply = Promise.withResolvers<PromptReceipt>();
  const seen: SendOutcome[] = [];
  const pending = f.owner.send(
    (dispatch) => {
      dispatch();
      return reply.promise;
    },
    undefined,
    "native-send",
    { outcome: (value) => seen.push(value) },
  );
  try {
    f.message("unrelated");
    assertEquals(seen, []);
    f.message("native-send");
    assertEquals(seen, [{ kind: "committed", messageID: "native-send" }]);
  } finally {
    reply.resolve({ messageID: "native-send", state: "accepted" });
    await pending;
    f.owner.stop();
  }
});

Deno.test("send custody stays correlated after an unconfirmed receipt disappears", async () => {
  const f = fixture();
  const seen: SendOutcome[] = [];
  try {
    await f.owner.send(
      (dispatch) => {
        dispatch();
        return Promise.resolve({
          state: "unconfirmed",
          reason: "Cannot confirm",
        });
      },
      undefined,
      "native-send",
      { outcome: (value) => seen.push(value) },
    );
    assertEquals(f.owner.state.receipts, []);
    f.message("native-send");
    f.message("native-send");
    assertEquals(seen.map((value) => value.kind), ["unconfirmed", "committed"]);
  } finally {
    f.owner.stop();
  }
});

Deno.test("send custody restores the untouched composer once with its whole original draft", async () => {
  const f = fixture();
  const drafts = createDrafts();
  const key = "server/session";
  const original: Draft = {
    input: "  exact\nraw text ",
    mode: "shell",
    agent: "reviewer",
    variant: undefined,
    editor: { text: "unsaved editor buffer", chipID: "image" },
    chips: [{
      id: "image",
      label: "image.png",
      part: {
        kind: "file",
        source: "upload",
        name: "image.png",
        mime: "image/png",
        dataBase64: "ABCD",
      },
    }],
  };
  const draft = drafts.writer(key)(original);
  const submit = createSessionSubmission({
    sessionID: "opcv2-root",
    delivery: f.owner,
    directory: () => Promise.resolve("/p"),
    tabs: () => ({ send: (_id, send) => send() }),
    inbox: { act: (_directory, send) => send() },
  });
  const capture = drafts.captureSend?.(key, draft);
  const response = Promise.withResolvers<PromptReceipt>();
  const dispatched = Promise.withResolvers<string>();
  const outcome = submit(
    (_opts, dispatch, id) => {
      dispatch();
      dispatched.resolve(id);
      return response.promise;
    },
    "composer",
    undefined,
    capture,
  );
  try {
    const id = await dispatched.promise;
    assertEquals(drafts.current(key), {
      input: "",
      chips: [],
      mode: "normal",
      agent: "reviewer",
      variant: undefined,
    });
    response.reject(
      new RequestFailure({
        code: "native.refused",
        diagnosticID: "known",
        retry: "new-intent",
        facts: { outcome: "rejected" },
      }),
    );
    await outcome;
    assertEquals(drafts.current(key), original);
    assertEquals(drafts.recoveries(key), []);
    drafts.writer(key)((value) => ({ ...value, input: "newer" }));
    f.message(id);
    assertEquals(drafts.current(key).input, "newer");
  } finally {
    f.owner.stop();
  }
});

Deno.test("send bookkeeping observes only its canonical native identity once, including admission before acknowledgement", async () => {
  const seen: UserMessage[] = [], f = fixture((message) => seen.push(message));
  const acknowledgement = Promise.withResolvers<PromptReceipt>();
  const pending = f.owner.send(() => acknowledgement.promise, {
    intent: { clientID: "tab", key: "own-send" },
    message: pendingMessage("sent", "opcv2-root", [{
      kind: "text",
      text: "No catalog default yet",
    }]),
    phase: "pending",
  });
  assertEquals(seen, []);
  f.message("unrelated", { provider: "other", model: "other" });
  assertEquals(seen, []);
  f.message("sent", { provider: "native", model: "applied-default" });
  assertEquals(seen.map((message) => message.model), [{
    provider: "native",
    model: "applied-default",
  }]);
  acknowledgement.resolve({ messageID: "sent", state: "accepted" });
  await pending;
  f.message("sent", { provider: "native", model: "applied-default" });
  f.owner.presented(["sent"]);
  assertEquals(seen.length, 1);
  f.owner.stop();
});

Deno.test("applied prompt bookkeeping survives presentation before native model metadata", async () => {
  const seen: UserMessage[] = [], f = fixture((message) => seen.push(message));
  const sending = f.owner.send(
    () => Promise.resolve({ messageID: "sent", state: "accepted" }),
    {
      intent: { clientID: "tab", key: "metadata-later" },
      message: pendingMessage("sent", "opcv2-root", [{
        kind: "text",
        text: "Send",
      }]),
      phase: "pending",
    },
  );
  await Promise.resolve();
  f.message("sent");
  // Native acceptance hands the send to its pending entry (2.39).
  assertEquals(await sending, { kind: "accepted", messageID: "sent" });
  assertEquals(seen, []);
  f.owner.presented(["sent"]);
  assertEquals(f.owner.state.receipts, []);
  f.message("unrelated", { provider: "other", model: "other" });
  assertEquals(seen, []);
  f.message("sent", { provider: "native", model: "applied-later" });
  f.message("sent", { provider: "native", model: "applied-later" });
  assertEquals(seen.map((message) => message.model), [{
    provider: "native",
    model: "applied-later",
  }]);
  f.owner.stop();
});

Deno.test("accepted send is not admitted or presented by RPC success, deadline or another identity", async () => {
  const f = fixture();
  let sends = 0;
  const sending = f.owner.send(() => {
    sends++;
    return Promise.resolve({ messageID: "sent", state: "queued" });
  });
  await Promise.resolve();
  assertEquals(f.owner.state.receipts[0].phase, "queued");
  assertEquals(f.counts().reads, 1);
  f.owner.presented(["other"]);
  f.expire();
  assertEquals((await sending).kind, "failed");
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
  assertEquals(
    (await f.owner.send(() => Promise.reject(new Error("rejected")))).kind,
    "refused",
  );
  assertEquals(f.owner.state.receipts, []);
  assertEquals(f.counts().reads, 0);
  assertEquals(f.owner.state.follow, 1);
  f.owner.stop();
});

Deno.test("pending input is visible before acknowledgement and commits by identity before result", async () => {
  const f = fixture(), acknowledgement = Promise.withResolvers<PromptReceipt>();
  const entry = {
    intent: { clientID: "tab", key: "send-key" },
    message: pendingMessage("msg_local", "opcv2-root", [{
      kind: "text",
      text: "Sent now",
    }]),
    phase: "pending" as const,
  };
  const sending = f.owner.send(() => acknowledgement.promise, entry);
  let duplicates = 0;
  const duplicate = f.owner.send(() => {
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
  assertEquals(await sending, { kind: "committed", messageID: "msg_local" });
  assertEquals(await duplicate, { kind: "committed", messageID: "msg_local" });
  await f.owner.send(() => {
    duplicates++;
    return Promise.resolve(null);
  }, entry);
  assertEquals(duplicates, 0);
  assertEquals(f.projection.state.replyIDs, ["send-key"]);
  assertEquals(f.owner.state.receipts, []);
  f.owner.stop();
});

Deno.test("refused submission preparation retires only its unsubmitted entry, leaving the failure with its preparation owner", async () => {
  const f = fixture();
  const entry = {
    intent: { clientID: "tab", key: "preparation" },
    message: pendingMessage("msg_preparation", "opcv2-root", [{
      kind: "text",
      text: "Retained draft",
    }]),
    phase: "pending" as const,
  };
  const outcome = await f.owner.send(() =>
    Promise.reject(
      new RequestFailure({
        code: "archive.storage",
        retry: "new-intent",
        diagnosticID: "preservation",
        facts: {
          actionLabel: "Saving an earlier branch",
          reason: "Storage is full",
        },
      }),
    ), entry);
  assert(outcome.kind === "refused");
  assertEquals(outcome.reason, "Storage is full");
  assertEquals(f.projection.entry(entry.message.id), undefined);
  assertEquals(f.owner.state.receipts, []);
  assertEquals(f.counts().timers, 0);
  f.owner.stop();
});

Deno.test("unacknowledged send has bounded visible failure; Retry observes without another mutation", async () => {
  const f = fixture(), acknowledgement = Promise.withResolvers<PromptReceipt>();
  let sends = 0;
  const sending = f.owner.send(() => {
    sends++;
    return acknowledgement.promise;
  }, {
    intent: { clientID: "tab", key: "send-key" },
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
  const sending = f.owner.send(
    () => Promise.resolve({ messageID: "msg_pending", state: "accepted" }),
    {
      intent: { clientID: "tab", key: "send-key" },
      message: pendingMessage("msg_pending", "opcv2-root", [{
        kind: "text",
        text: "Native source still missing",
      }]),
      phase: "pending",
    },
  );
  await Promise.resolve();
  assertEquals(f.counts().reads, 1);
  assertEquals(f.owner.state.receipts[0].phase, "accepted");
  f.message("different-native-identity");
  assertEquals(f.projection.committed("msg_pending"), false);
  f.expire();
  // The entry, not a second composer outcome, owns the observation failure.
  assertEquals((await sending).kind, "accepted");
  assertEquals(f.projection.entry("msg_pending")?.send?.phase, "failed");
  f.owner.stop();
});

Deno.test("an entry committed before native acceptance settles as committed", async () => {
  const f = fixture();
  const accepted = Promise.withResolvers<
    { messageID: string; state: "accepted" }
  >();
  const sending = f.owner.send(() => accepted.promise, {
    intent: { clientID: "tab", key: "early-commit" },
    message: pendingMessage("msg_early", "opcv2-root", [{
      kind: "text",
      text: "Observed first",
    }]),
    phase: "pending",
  });
  await Promise.resolve();
  f.message("msg_early");
  accepted.resolve({ messageID: "msg_early", state: "accepted" });
  assertEquals(await sending, { kind: "committed", messageID: "msg_early" });
  f.owner.stop();
});

Deno.test("definite failure retains the prompt and Retry action in that same entry", async () => {
  const f = fixture();
  let retries = 0;
  const outcome = await f.owner.send((dispatch) => {
    dispatch();
    return Promise.reject(
      new RequestFailure({
        code: "native.refused",
        retry: "new-intent",
        diagnosticID: "refused",
        facts: {
          outcome: "rejected",
          reason: "The selected model is unavailable.",
          origin: "composer",
          record: { messageID: "native-failure" },
        },
      }),
    );
  }, {
    intent: { clientID: "tab", key: "send-key" },
    message: pendingMessage("msg_failure", "opcv2-root", [{
      kind: "text",
      text: "Retained",
    }]),
    phase: "pending",
    retry: () => {
      retries++;
    },
  });
  assertEquals(outcome.kind, "failed");
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

Deno.test("every correlated kind keeps canonical commitment after a lost native acknowledgement", async () => {
  const f = fixture(), response = Promise.withResolvers<PromptReceipt>();
  const sending = f.owner.send(
    (dispatch) => {
      dispatch();
      return response.promise;
    },
    undefined,
    "shell-source",
  );
  f.message("shell-source");
  response.reject(new Error("Native response lost after admission"));
  assertEquals(await sending, { kind: "committed", messageID: "shell-source" });
  f.owner.stop();
});

Deno.test("uncorrelatable native completion is explicitly unconfirmed, never committed", async () => {
  const f = fixture();
  const outcome = await f.owner.send(() =>
    Promise.resolve({
      state: "unconfirmed",
      reason: "This native command API has no identity.",
    })
  );
  assert(outcome.kind === "unconfirmed");
  assertEquals(outcome.reason, "This native command API has no identity.");
  assertEquals(f.owner.state.receipts, []);
  assertEquals(f.counts().timers, 0);
  f.owner.stop();
});

Deno.test("owner retirement closes an outstanding send once, even if native acknowledgement arrives later", async () => {
  const f = fixture(), acknowledgement = Promise.withResolvers<PromptReceipt>();
  let outcomes = 0;
  const sending = f.owner.send((dispatch) => {
    dispatch();
    return acknowledgement.promise;
  }).then((outcome) => {
    outcomes++;
    return outcome;
  });
  f.owner.stop();
  assertEquals((await sending).kind, "unconfirmed");
  acknowledgement.resolve({ messageID: "late", state: "accepted" });
  await Promise.resolve();
  assertEquals(outcomes, 1);
  assertEquals(f.counts().timers, 0);
});

for (
  const code of [
    "request.expired",
    "request.disconnected",
    "native.4xx",
    "native.5xx",
  ]
) {
  Deno.test(`${code} closes the native Send with its visible reason and retry`, async () => {
    const f = fixture();
    const outcome = await f.owner.send((dispatch) => {
      dispatch();
      return Promise.reject(
        new RequestFailure({
          code,
          diagnosticID: code,
          retry: "new-intent",
          facts: { reason: code },
        }),
      );
    });
    assert(outcome.kind === "failed");
    assertEquals(outcome.reason, code);
    assertEquals(typeof outcome.retry, "function");
    f.owner.stop();
  });
}
