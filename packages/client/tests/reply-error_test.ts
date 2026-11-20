// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals } from "@std/assert";
import type { AssistantMessage, PublicFailure } from "@otk/protocol";
import { replyErrorFeedback } from "../failure-features.ts";

const message: AssistantMessage = {
  id: "reply",
  sessionID: "opcv2-ses_review",
  role: "assistant",
  agent: "junior",
  model: { provider: "openai", model: "gpt-6.1-sol" },
  time: { created: 1, completed: 2 },
  terminal: true,
  interrupted: false,
  cost: null,
  tokens: {
    input: null,
    output: null,
    reasoning: null,
    cache: { read: null, write: null },
  },
  parts: [],
  error: { kind: "usage-limit", message: "The usage limit has been reached" },
};
const retained: PublicFailure = {
  code: "native.execution",
  retry: "none",
  diagnosticID: "execution-review",
  facts: {
    target: { sessionID: message.sessionID },
    record: { messageID: "retained-failure" },
    reason: message.error!.message,
  },
};
Deno.test("a retained execution record owns the reply error once, without prose matching", () => {
  assertEquals(replyErrorFeedback(message, [retained]), undefined);
  assertEquals(
    replyErrorFeedback(message, [{
      ...retained,
      facts: { ...retained.facts, reason: "Producer-enriched quota reason" },
    }]),
    undefined,
  );
  assertEquals(
    replyErrorFeedback(message, [])?.failure?.reason,
    message.error!.message,
  );
});
Deno.test("unrelated tool, command or other-session failures never hide the reply's own error", () => {
  for (
    const failure of [
      { ...retained, code: "tool.execution" },
      { ...retained, code: "action.local" },
      {
        ...retained,
        facts: { ...retained.facts, target: { sessionID: "opcv2-ses_other" } },
      },
      { ...retained, facts: { target: retained.facts!.target } },
    ]
  ) {
    assertEquals(
      replyErrorFeedback(message, [failure])?.failure?.reason,
      message.error!.message,
    );
  }
  assertEquals(
    replyErrorFeedback({ ...message, interrupted: true }, []),
    undefined,
  );
});
