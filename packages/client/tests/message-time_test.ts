// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals } from "@std/assert";
import { messagePresentation } from "../message-presentation.ts";
import {
  type AssistantMessage,
  knownDerived,
  type UsageSummary,
} from "@otk/protocol";

const reply: AssistantMessage = {
  id: "a",
  sessionID: "s",
  role: "assistant",
  replyTo: "p",
  time: { created: 1, completed: 2 },
  agent: "build",
  model: { provider: "fixture", model: "model" },
  tokens: {
    input: null,
    output: null,
    reasoning: null,
    cache: { read: null, write: null },
  },
  cost: null,
  interrupted: false,
  parts: [],
};
Deno.test("message timing separates unfinished digestion from unknown evidence", () => {
  for (const summary of [undefined, { state: "pending" } as const]) {
    const time = messagePresentation(reply, summary).time;
    assertEquals(time?.fallback, "counting...");
  }
  const timing = {
    state: "unknown" as const,
    terminal: true,
    start: 1,
    reason: "migration" as const,
  };
  const summary: UsageSummary = {
    calls: 1,
    tokens: reply.tokens,
    cost: null,
    contextPeak: null,
    timing,
  };
  assertEquals(
    messagePresentation(reply, knownDerived(summary, "fixture", 1)).time
      ?.timing,
    timing,
  );
});
Deno.test("a measured duration keeps its unfinished finality until digestion settles", () => {
  const summary: UsageSummary = {
    calls: 1,
    tokens: reply.tokens,
    cost: null,
    contextPeak: null,
    timing: { state: "known", start: 1, end: 2, workingMs: 1 },
  };
  assertEquals(
    Reflect.get(
      messagePresentation(reply, knownDerived(summary, "fixture", 1, false))
        .time!,
      "counting",
    ),
    true,
  );
  assertEquals(
    Reflect.get(
      messagePresentation(reply, knownDerived(summary, "fixture", 1, true))
        .time!,
      "counting",
    ),
    undefined,
  );
});
