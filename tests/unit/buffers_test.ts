// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals } from "@std/assert";
import type { ContentOp } from "../../protocol/content.ts";
import { StreamBuffers } from "../../sidecar/content/buffers.ts";
import { markdown } from "../../sidecar/content/markdown.ts";

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

Deno.test("buffers survive an intermediate unsubscribe and free on the last subscriber", async () => {
  const buffers = new StreamBuffers(), events: ContentOp[] = [];
  buffers.subscriptions("session", 2);
  buffers.upsert("session", "message", part, "start");
  buffers.append(part.id, " tail", (_id, event) => events.push(event));
  buffers.subscriptions("session", 1);
  assertEquals(buffers.size, 1);
  buffers.subscriptions("session", 0);
  assertEquals(buffers.size, 0);
  await sleep();
  assertEquals(events, []);
  buffers.stop();
});

Deno.test("buffers never allocate for an unsubscribed or unseeded part", () => {
  const buffers = new StreamBuffers();
  buffers.upsert("session", "message", part, "unviewed");
  assertEquals(buffers.size, 0);
  buffers.subscriptions("session", 1);
  assertEquals(buffers.append(part.id, "unseeded", () => {}), false);
  assertEquals(buffers.size, 0);
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
