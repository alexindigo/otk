// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals } from "@std/assert";
import { mapMessage } from "../map.ts";
import { requestFailureRecord } from "../request-failure.ts";
import { createTranscriptProjection, messagePresentation } from "@otk/client";

const raw = {
  id: "failed-call",
  type: "assistant" as const,
  agent: "build",
  model: { providerID: "openai", id: "gpt-6.1-sol" },
  content: [],
  time: { created: 1000, completed: 1500 },
  error: {
    type: "provider.quota",
    message: "The usage limit has been reached",
  },
};
Deno.test("failed calls keep their native outcome time without a streamed clock", () => {
  const message = mapMessage(raw, "opcv2-s", { order: 1 });
  assert(message.role === "assistant");
  assertEquals(message.role === "assistant" && message.outcomeTime, {
    state: "known",
    at: 1500,
    source: "completed",
  });
  assertEquals(messagePresentation(message).time?.outcome, message.outcomeTime);
});
Deno.test("aborted calls keep their native completion time", () => {
  const message = mapMessage(
    {
      ...raw,
      error: { type: "interrupted", message: "Interrupted" },
    },
    "opcv2-s",
    { order: 1 },
  );
  assert(message.role === "assistant");
  assertEquals(message.role === "assistant" && message.interrupted, true);
  assertEquals(message.outcomeTime, {
    state: "known",
    at: 1500,
    source: "completed",
  });
});
Deno.test("settlement without native endpoint clocks stays explicitly unknown", () => {
  const message = mapMessage({ ...raw, time: { created: 1000 } }, "opcv2-s", {
    order: 1,
  });
  assert(message.role === "assistant");
  assertEquals(message.outcomeTime, {
    state: "unknown",
    reason: "No native completion, error or part timestamp was recorded.",
  });
  assertEquals(messagePresentation(message).time?.outcome, message.outcomeTime);
});
Deno.test("failed-idle and interrupted-idle records carry the native event time", () => {
  for (const outcome of ["failed", "interrupted", "succeeded"] as const) {
    const message = mapMessage(
      {
        id: "idle",
        type: "idle",
        outcome,
        time: { created: 1600 },
      },
      "opcv2-s",
      { order: 2 },
    );
    assert(message.role === "context");
    assertEquals(message.outcomeTime, {
      state: "known",
      at: 1600,
      source: "event",
    });
  }
});
Deno.test("grouped failed run retains the last assistant's outcome independently of digest timing", () => {
  const projection = createTranscriptProjection();
  const message = mapMessage(raw, "opcv2-s", { order: 2, replyTo: "prompt" });
  projection.reset([
    mapMessage(
      { ...raw, id: "previous", time: { created: 100, completed: 900 } },
      "opcv2-s",
      { order: 1, replyTo: "prompt" },
    ),
    message,
  ]);
  const reply = projection.state.repliesByID["reply:prompt"].message;
  assertEquals(messagePresentation(reply).time?.outcome, {
    state: "known",
    at: 1500,
    source: "completed",
  });
  assertEquals(messagePresentation(reply, undefined, "saved").time?.outcome, {
    state: "known",
    at: 1500,
    source: "completed",
  });
});

Deno.test("an interrupted call without completed uses its last native part clock", () => {
  const message = mapMessage(
    {
      ...raw,
      time: { created: 1000 },
      content: [{
        type: "reasoning",
        text: "thinking",
        time: { created: 1100, completed: 1400 },
      }],
      error: { type: "interrupted", message: "Interrupted" },
    },
    "opcv2-s",
    { order: 1 },
  );
  assert(message.role === "assistant");
  assertEquals(message.outcomeTime, {
    state: "known",
    at: 1400,
    source: "part",
  });
});
Deno.test("retained failures use their native error clock, not HTTP observation time", () => {
  const failure = {
    code: "native.execution",
    retry: "none" as const,
    diagnosticID: "failure",
  };
  assertEquals(requestFailureRecord("opcv2-s", failure, 1600).outcomeTime, {
    state: "known",
    at: 1600,
    source: "error",
  });
  assertEquals(
    requestFailureRecord("opcv2-s", failure).outcomeTime?.state,
    "unknown",
  );
});
