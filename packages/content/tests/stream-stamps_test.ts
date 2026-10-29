// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals, assertThrows } from "@std/assert";
import type { ContentOp, Message } from "@otk/protocol";
import { emptyContent, reduce } from "@otk/client";
import { markdown, StreamBuffers } from "../mod.ts";

Deno.test("a mid-coalescing checkpoint aligns both existing and new viewers with the next published suffix", async () => {
  const buffers = new StreamBuffers();
  const message: Message = {
    id: "m",
    sessionID: "s",
    role: "assistant",
    agent: "build",
    model: { provider: "p", model: "m" },
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    cost: 0,
    interrupted: false,
    time: { created: 1 },
    parts: [],
  };
  const part = { kind: "text" as const, id: "p", synthetic: false, blocks: [] };
  buffers.subscriptions("s", 1);
  buffers.epoch("s", "epoch");
  buffers.upsert("s", "m", part, "# First\n\n");
  let first = { ...emptyContent(), messages: [buffers.overlay(message)] };
  let second = emptyContent();
  const events: ContentOp[] = [];
  const emit = (_id: string, event: ContentOp) => {
    events.push(event);
    first = reduce(first, event);
    if (second.messages.length) second = reduce(second, event);
  };
  try {
    buffers.append("p", "one", emit);
    buffers.append("p", " two", emit);
    buffers.checkpoint("s", emit);
    second = { ...emptyContent(), messages: [buffers.overlay(message)] };
    const base = buffers.snapshot("p")!.part.stream!.version;
    buffers.append("p", " three\n", emit);
    buffers.append("p", "\nLast.", emit);
    await new Promise((resolve) => setTimeout(resolve, 75));
    const delta = events.findLast((event) => event.op === "part.blocks");
    assert(delta?.op === "part.blocks");
    assertEquals(delta.baseVersion, base);
    assert(delta.stream.version > base);
    for (const state of [first, second]) {
      const text = state.messages[0].parts[0];
      assert(text.kind === "text");
      assertEquals(text.blocks, markdown("# First\n\none two three\n\nLast."));
    }
  } finally {
    buffers.stop();
  }
});

Deno.test("HTTP replacements cannot seed suffixes, event authority outranks them and completed headers reject late streams", () => {
  const buffers = new StreamBuffers();
  buffers.epoch("s", "epoch");
  const part = {
    kind: "text" as const,
    id: "p",
    synthetic: false,
    blocks: markdown("HTTP source"),
    stream: buffers.replacement("s"),
  };
  const message: Message = {
    id: "m",
    sessionID: "s",
    role: "assistant",
    agent: "build",
    model: { provider: "p", model: "m" },
    cost: null,
    tokens: {
      input: null,
      output: null,
      reasoning: null,
      cache: { read: null, write: null },
    },
    interrupted: false,
    time: { created: 1 },
    parts: [part],
  };
  let state: ReturnType<typeof emptyContent> = {
    ...emptyContent(),
    messages: [message],
  };
  assertThrows(
    () =>
      reduce(state, {
        op: "part.blocks",
        messageID: "m",
        partID: "p",
        from: 0,
        blocks: markdown("Speculative suffix"),
        stream: { ...part.stream, version: part.stream.version + 1 },
        baseVersion: part.stream.version,
      }),
    Error,
    "stream-gap",
  );
  buffers.upsert("s", "m", part, "Event source");
  const seed = buffers.snapshot("p")!.part;
  assert(seed.stream!.generation > part.stream.generation);
  state = reduce(state, { op: "part.upsert", messageID: "m", part: seed });
  state = reduce(state, { op: "part.upsert", messageID: "m", part });
  assertEquals(state.messages[0].parts[0], seed);
  state = reduce(state, {
    op: "message.upsert",
    message: { ...message, time: { created: 1, completed: 5 }, parts: [] },
  });
  const terminal = state.messages[0];
  buffers.upsert("s", "m", part, "Late source");
  state = reduce(state, {
    op: "part.upsert",
    messageID: "m",
    part: buffers.snapshot("p")!.part,
  });
  assertEquals(state.messages[0], terminal);
  buffers.stop();
});
