// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals } from "@std/assert";
import type { AssistantMessage, ContentOp } from "@otk/protocol";
import { markdown, StreamBuffers } from "@otk/content";

const part = {
  kind: "text" as const,
  id: "part",
  blocks: [],
  synthetic: false,
};
const sleep = () => new Promise((resolve) => setTimeout(resolve, 75));

Deno.test("buffers own one subscribed stream and coalesce its deltas", async () => {
  const buffers = new StreamBuffers(), events: ContentOp[] = [];
  try {
    buffers.subscriptions("session", 1);
    buffers.upsert("session", "message", part, "# Heading\n\n");
    assertEquals(buffers.size, 1);
    const emit = (_id: string, event: ContentOp) => events.push(event);
    assert(buffers.append(part.id, "First", emit));
    assert(buffers.append(part.id, " second", emit));
    await sleep();
    assertEquals(events.length, 1);
    const event = events[0];
    assert(event.op === "part.blocks");
    assertEquals(event.blocks, markdown("# Heading\n\nFirst second"));
  } finally {
    buffers.stop();
  }
});
Deno.test("unwatched snapshots and late replay include unflushed text, RAM time and current version without crossing message owners", async () => {
  const buffers = new StreamBuffers(),
    events: ContentOp[] = [],
    before = Date.now();
  try {
    buffers.upsert("session", "message", part, "first");
    const seeded = buffers.snapshot(part.id)!;
    buffers.append(part.id, " second", (_id, op) => events.push(op));
    await sleep();
    assertEquals(events, []);
    const current = buffers.snapshot(part.id)!;
    assert(current.lastChunk >= before);
    assert(
      (current.part.streamVersion || 0) > (seeded.part.streamVersion || 0),
    );
    assertEquals(current.part.blocks, markdown("first second"));
    buffers.subscriptions("session", 1);
    buffers.replay("session", (_id, op) => events.push(op));
    assertEquals(events, [{
      op: "part.upsert",
      messageID: "message",
      part: current.part,
      lastOutput: current.lastChunk,
    }]);
    const message: AssistantMessage = {
      id: "message",
      sessionID: "session",
      role: "assistant",
      agent: "build",
      time: { created: 1 },
      model: { provider: "fixture", model: "model" },
      tokens: {
        input: 0,
        output: 0,
        reasoning: 0,
        cache: { read: 0, write: 0 },
      },
      cost: 0,
      interrupted: false,
      parts: [],
    };
    assert(message.role === "assistant");
    assertEquals(buffers.overlay(message).parts, [current.part]);
    assertEquals(buffers.overlay({ ...message, id: "another" }).parts, []);
    assertEquals(
      buffers.overlay({ ...message, sessionID: "another" }).parts,
      [],
    );
    assertEquals(
      buffers.overlay({ ...message, time: { created: 1, completed: 2 } }).parts,
      [],
    );
  } finally {
    buffers.stop();
  }
});
for (
  const removal of ["part", "message", "session", "reset", "stop"] as const
) {
  Deno.test(`unwatched raw source and pending tails are released by ${removal}`, async () => {
    const buffers = new StreamBuffers(), events: ContentOp[] = [];
    buffers.subscriptions("session", 1);
    buffers.upsert("session", "message", part, "unfinished");
    buffers.append(part.id, " queued", (_id, op) => events.push(op));
    if (removal === "part") buffers.remove(part.id);
    if (removal === "message") buffers.removeMessage("message");
    if (removal === "session") buffers.removeSession("session");
    if (removal === "reset") buffers.reset();
    if (removal === "stop") buffers.stop();
    assertEquals(buffers.size, 0);
    assertEquals(buffers.snapshot(part.id), undefined);
    await sleep();
    assertEquals(events, []);
    buffers.stop();
  });
}

Deno.test("buffers completion emits authoritative final content and cancels pending tails", async () => {
  const buffers = new StreamBuffers(), events: ContentOp[] = [];
  buffers.subscriptions("session", 1);
  buffers.upsert("session", "message", part, "# Heading\n\n");
  const emit = (_id: string, event: ContentOp) => events.push(event);
  buffers.append(part.id, "Done", emit);
  buffers.complete("message", emit);
  assertEquals(buffers.size, 0);
  await sleep();
  assertEquals(events.length, 1);
  const event = events[0];
  assert(event.op === "part.upsert" && event.part.kind === "text");
  assertEquals(event.part.blocks, markdown("# Heading\n\nDone"));
  buffers.stop();
});

Deno.test("streaming buffers survive every unsubscribe without emitting an unwatched tail", async () => {
  const buffers = new StreamBuffers(), events: ContentOp[] = [];
  buffers.subscriptions("session", 2);
  buffers.upsert("session", "message", part, "start");
  buffers.append(part.id, " tail", (_id, event) => events.push(event));
  buffers.subscriptions("session", 1);
  assertEquals(buffers.size, 1);
  buffers.subscriptions("session", 0);
  assertEquals(buffers.size, 1);
  await sleep();
  assertEquals(events, []);
  buffers.stop();
});

Deno.test("buffers retain authoritative unwatched seeds but never invent an unseeded part", () => {
  const buffers = new StreamBuffers();
  buffers.upsert("session", "message", part, "unviewed");
  assertEquals(buffers.size, 1);
  buffers.subscriptions("session", 1);
  assertEquals(buffers.append("unknown-part", "unseeded", () => {}), false);
  assertEquals(buffers.size, 1);
  buffers.stop();
});

Deno.test("buffers release on completed part removal, reconnect reset and stop", async () => {
  const buffers = new StreamBuffers(), events: ContentOp[] = [];
  buffers.subscriptions("session", 1);
  buffers.upsert("session", "message", part, "streaming");
  buffers.remove(part.id);
  assertEquals(buffers.size, 0);
  buffers.upsert("session", "message", part, "streaming");
  buffers.reset();
  assertEquals(buffers.size, 0);
  assert(buffers.subscribed("session"));
  buffers.upsert("session", "message", part, "streaming");
  buffers.append(part.id, " tail", (_id, event) => events.push(event));
  buffers.stop();
  assertEquals(buffers.size, 0);
  assert(!buffers.subscribed("session"));
  await sleep();
  assertEquals(events, []);
});
