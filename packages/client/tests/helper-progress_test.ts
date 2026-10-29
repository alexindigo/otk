// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals, assertStrictEquals } from "@std/assert";
import type { AssistantMessage, HelperSummary } from "@otk/protocol";
import { createTranscriptProjection } from "../transcript-projection.ts";
Deno.test("borrowed helper digests patch keyed parts, deduplicate content delivery and retire replaced links", () => {
  const projection = createTranscriptProjection();
  const message: AssistantMessage = {
    id: "a",
    sessionID: "tstv1-parent",
    role: "assistant",
    replyTo: "u",
    model: { provider: "test", model: "test" },
    agent: "build",
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    cost: 0,
    interrupted: false,
    time: { created: 1, completed: 5 },
    parts: [{
      id: "task",
      kind: "tool",
      call: {
        tool: "task",
        callID: "call",
        awaitingPermission: false,
        title: "Inspect",
        status: "completed",
        description: "Inspect",
        childSessionID: "tstv1-child",
        time: { start: 1, end: 5 },
      },
    }],
  };
  projection.replace([message]);
  const summary: HelperSummary = {
    state: "ready",
    revision: 1,
    toolCount: 2,
    time: { start: 2, end: 20 },
  };
  assertEquals(projection.helpers(() => summary), true);
  const current = projection.state.messagesByID.a;
  const part = current.parts[0];
  assertEquals(
    part.kind === "tool" && part.call.tool === "task" &&
      part.call.progress?.toolCount,
    2,
  );
  assertEquals(
    part.kind === "tool" && part.call.time.end,
    5,
    "Derived helper time cannot rewrite parent completion",
  );
  projection.apply({
    op: "task.progress",
    messageID: "a",
    partID: "task",
    childSessionID: "tstv1-child",
    summary,
  });
  assertStrictEquals(projection.state.messagesByID.a, current);
  projection.apply({ op: "part.remove", messageID: "a", partID: "task" });
  let reads = 0;
  projection.helpers(() => {
    reads++;
    return summary;
  });
  assertEquals(reads, 0);
  projection.clear();
  assertEquals(projection.state.messageIDs, []);
});
