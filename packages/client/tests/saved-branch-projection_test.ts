// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals } from "@std/assert";
import {
  messagePresentation,
  type SavedBranch,
  savedBranchProjection,
} from "@otk/client";
import {
  type AssistantMessage,
  type Derived,
  knownDerived,
  type UsageSummary,
} from "@otk/protocol";

const message: AssistantMessage = {
  id: "a",
  sessionID: "s",
  role: "assistant",
  replyTo: "p",
  time: { created: 1 },
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
const value: UsageSummary = {
  calls: 1,
  cost: 0,
  tokens: { input: 2, output: 3, reasoning: 0, cache: { read: 0, write: 0 } },
  contextPeak: 2,
  timing: { state: "known", start: 1, end: 11, workingMs: 10 },
};
function branch(summary?: Derived<UsageSummary>): SavedBranch {
  return {
    id: "saved",
    boundary: "p",
    created: 1,
    bytes: 1,
    pending: false,
    committedAt: 11,
    session: {
      id: "s",
      title: "Saved",
      directory: "/project",
      projectID: "p",
      archived: false,
      time: { created: 1, updated: 1 },
    },
    messages: [message],
    turns: summary
      ? {
        p: {
          boundary: { turnID: "p", firstID: "a", lastID: "a", complete: false },
          summary,
        },
      }
      : {},
    prompts: [],
    drafts: [],
  };
}
Deno.test("saved projection admits no live activity or unresolved metadata and never invents terminal evidence", () => {
  for (
    const summary of [undefined, { state: "pending" }, {
      state: "unavailable",
    }] as (Derived<UsageSummary> | undefined)[]
  ) {
    const saved = branch(summary), before = JSON.stringify(saved);
    const result = savedBranchProjection(saved);
    assertEquals(result.presentations["reply:p"], {
      streaming: false,
      progress: false,
      facts: [],
    });
    assertEquals(JSON.stringify(saved), before);
    assertEquals(result.repliesByID["reply:p"].message.time, { created: 1 });
  }
  assertEquals(messagePresentation(message).streaming, true);
  assertEquals(messagePresentation(message).time, {
    timing: undefined,
    fallback: "counting...",
  });
});
Deno.test("saved projection retains only known captured facts, including zero and partial usage", () => {
  const project = (v: UsageSummary, showCost = true) =>
    savedBranchProjection(branch(knownDerived(v, "fixture", 1)), showCost)
      .presentations["reply:p"];
  assertEquals(project(value), {
    streaming: false,
    progress: false,
    time: { timing: value.timing },
    facts: ["1 model call", "5 tokens", "$0.00"],
  });
  assertEquals(project(value, false).facts, ["1 model call", "5 tokens"]);
  for (
    const timing of [undefined, { state: "active", start: 1, workingMs: 10 }, {
      state: "unknown",
      start: 1,
      terminal: true,
      reason: "missing-end",
    }] as UsageSummary["timing"][]
  ) {
    assertEquals(
      project({ ...value, timing, tokens: message.tokens, cost: null }),
      { streaming: false, progress: false, facts: ["1 model call"] },
    );
  }
});
