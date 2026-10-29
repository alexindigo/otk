// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals } from "@std/assert";
import type { AssistantMessage } from "@otk/protocol";
import { createTranscriptProjection } from "../transcript-projection.ts";

const step = (id: string, created: number): AssistantMessage => ({
  id,
  sessionID: "tstv1-s",
  role: "assistant",
  replyTo: "turn",
  agent: "build",
  model: { provider: "test", model: "test" },
  time: { created, completed: created + 1 },
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  cost: 0,
  interrupted: false,
  parts: [],
});
Deno.test("page boundaries do not freeze a growing reply's native fork boundary", () => {
  const owner = createTranscriptProjection();
  owner.replace([step("first", 1)]);
  owner.boundaries([{
    turnID: "turn",
    firstID: "first",
    lastID: "first",
    complete: true,
  }]);
  owner.apply({ op: "message.upsert", message: step("second", 2) });
  assertEquals(owner.state.repliesByID["reply:turn"].firstID, "first");
  assertEquals(owner.state.repliesByID["reply:turn"].lastID, "second");
  assertEquals(owner.state.replyIDs, ["reply:turn"]);
});
Deno.test("native message identities cannot collide with object prototype properties", () => {
  const owner = createTranscriptProjection();
  owner.replace([
    {
      id: "constructor",
      sessionID: "tstv1-s",
      role: "user",
      time: { created: 0 },
      parts: [],
    },
    step("__proto__", 1),
  ]);
  assertEquals(owner.state.messageIDs, ["constructor", "__proto__"]);
  assertEquals(owner.state.messagesByID["__proto__"].id, "__proto__");
  assertEquals(
    owner.state.repliesByID["constructor"].message.id,
    "constructor",
  );
});
