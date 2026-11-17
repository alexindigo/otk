// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals, assertStrictEquals } from "@std/assert";
import type { AssistantMessage, ContextMessage, Message } from "@otk/protocol";
import { createTranscriptProjection } from "../transcript-projection.ts";

const assistant = (): AssistantMessage => ({
  id: "assistant",
  sessionID: "tstv1-s",
  role: "assistant",
  replyTo: "prompt",
  agent: "build",
  model: { provider: "fixture", model: "model" },
  tokens: { input: 5, output: 2, reasoning: 1, cache: { read: 0, write: 0 } },
  cost: 0.01,
  interrupted: false,
  time: { created: 20, completed: 30 },
  parts: [{ id: "answer", kind: "text", synthetic: false, blocks: [] }],
});
const context = (id: string, created: number): ContextMessage => ({
  id,
  sessionID: "tstv1-s",
  role: "context",
  replyTo: "prompt",
  time: { created },
  parts: [{ id: id + "-part", kind: "external", name: "fixture/failure" }],
});
const user = (id: string, created: number): Message => ({
  id,
  sessionID: "tstv1-s",
  role: "user",
  time: { created },
  parts: [],
});

Deno.test("mixed replies keep assistant metadata separate from first and final source identity", () => {
  const p = createTranscriptProjection(), call = assistant();
  p.replace([
    user("prompt", 1),
    context("before", 10),
    call,
    context("after", 40),
  ]);
  const reply = p.state.repliesByID["reply:prompt"];
  assertEquals([reply.firstID, reply.lastID, reply.messageIDs], [
    "before",
    "after",
    ["before", "assistant", "after"],
  ]);
  assertEquals(reply.message.role, "assistant");
  if (reply.message.role !== "assistant") {
    throw new Error("Missing assistant authority");
  }
  assertEquals({
    agent: reply.message.agent,
    model: reply.message.model,
    tokens: reply.message.tokens,
    cost: reply.message.cost,
    time: reply.message.time,
  }, {
    agent: call.agent,
    model: call.model,
    tokens: call.tokens,
    cost: call.cost,
    time: call.time,
  });
  assertEquals(reply.segments.map((s) => s.messageID), [
    "before",
    "assistant",
    "after",
  ]);
  assertEquals(reply.message.parts.map((part) => part.id), [
    "before-part",
    "answer",
    "after-part",
  ]);
  p.boundaries([{
    turnID: "prompt",
    complete: true,
    firstID: "assistant",
    lastID: "assistant",
  }]);
  assertEquals(
    p.state.repliesByID["reply:prompt"].lastID,
    "after",
    "Trailing context remains the last source",
  );
});

Deno.test("mixed reply authority updates and retires only its actual assistant", () => {
  const p = createTranscriptProjection();
  p.replace([assistant(), context("after", 40)]);
  p.apply({
    op: "message.upsert",
    message: { ...assistant(), agent: "review", cost: 2 },
  });
  const reply = p.state.repliesByID["reply:prompt"].message;
  assertEquals(reply.role, "assistant");
  assertEquals(reply.role === "assistant" && [reply.agent, reply.cost], [
    "review",
    2,
  ]);
  p.apply({ op: "message.remove", messageID: "assistant" });
  assertEquals(p.state.repliesByID["reply:prompt"].message.role, "context");
  assertEquals(
    p.state.repliesByID["reply:prompt"].message.parts.map((p) => p.id),
    ["after-part"],
  );
  p.apply({ op: "message.upsert", message: assistant() });
  p.apply({ op: "message.remove", messageID: "after" });
  assertEquals(p.state.repliesByID["reply:prompt"].message.role, "assistant");
  assertEquals(p.state.repliesByID["reply:prompt"].lastID, "assistant");
});

Deno.test("removing the last assistant from a mixed reply retires its pending turn", () => {
  const p = createTranscriptProjection();
  p.replace([
    user("prompt", 1),
    { ...assistant(), time: { created: 20 } },
    context("after", 40),
    user("next", 50),
  ]);
  p.busy(true);
  assertEquals(p.state.repliesByID.prompt.pending, true);
  p.apply({ op: "message.remove", messageID: "assistant" });
  assertEquals(p.state.repliesByID.prompt.pending, false);
});

Deno.test("mixed reply part updates retain assistant authority without visiting historical sources", () => {
  const p = createTranscriptProjection();
  p.replace([context("before", 10), assistant(), context("after", 40)]);
  const before = p.state.messagesByID.before,
    call = p.state.messagesByID.assistant;
  let visits = 0;
  for (
    const [id, value] of [["before", before], ["assistant", call]] as const
  ) {
    Object.defineProperty(p.state.messagesByID, id, {
      configurable: true,
      get() {
        visits++;
        return value;
      },
    });
  }
  const segment = p.state.repliesByID["reply:prompt"].segments[0];
  p.apply({
    op: "part.upsert",
    messageID: "after",
    part: { id: "after-part", kind: "external", name: "fixture/updated" },
  });
  assertEquals(visits, 0);
  assertEquals(p.state.repliesByID["reply:prompt"].message.role, "assistant");
  assertStrictEquals(p.state.repliesByID["reply:prompt"].segments[0], segment);
});
