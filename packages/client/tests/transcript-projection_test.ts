// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals, assertStrictEquals } from "@std/assert";
import type { AssistantMessage, Message } from "@otk/protocol";
import { createTranscriptProjection } from "../transcript-projection.ts";
import { createTranscript } from "../transcript.ts";
import { SidecarConnection } from "../connection.ts";
import {
  fixtureMessagePolicy,
  fixturePage,
} from "../../../tests/support/message-pages.ts";

const step = (id: string, turn = "prompt", created = 1): AssistantMessage => ({
  id,
  sessionID: "tstv1-s",
  role: "assistant",
  replyTo: turn,
  model: { provider: "test", model: "test" },
  agent: "build",
  tokens: { input: 1, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  cost: 0,
  interrupted: false,
  time: { created, completed: created + 1 },
  parts: [{ id: `part-${id}`, kind: "text", synthetic: false, blocks: [] }],
});
Deno.test("message clock refinement preserves terminal authority and body identity without reviving removals", () => {
  const projection = createTranscriptProjection();
  const message = {
    ...step("clock"),
    time: { created: 1, completed: 10, lastOutput: 10 },
  };
  projection.replace([message, step("unrelated", "other", 20)]);
  const unrelated = projection.state.messagesByID.unrelated;
  const parts = projection.state.messagesByID.clock.parts;
  projection.apply({ op: "message.clock", messageID: "clock", lastOutput: 8 });
  assertEquals(projection.state.messagesByID.clock.time, {
    created: 1,
    completed: 10,
    lastOutput: 8,
  });
  assertStrictEquals(projection.state.messagesByID.clock.parts, parts);
  assertStrictEquals(projection.state.messagesByID.unrelated, unrelated);
  projection.apply({ op: "message.remove", messageID: "clock" });
  projection.apply({ op: "message.clock", messageID: "clock", lastOutput: 9 });
  assertEquals(projection.state.messagesByID.clock, undefined);
});
Deno.test("transcript projection keeps logical reply identity across earlier pages and visits no history on part replacement", () => {
  const projection = createTranscriptProjection();
  const history = Array.from(
    { length: 1525 },
    (_, i) => step(`m-${i}`, `u-${i}`, i),
  );
  projection.replace(history);
  const unchanged = projection.state.repliesByID["reply:u-1"];
  const ids = projection.state.messageIDs;
  // Accessing a historical record is observable: ordinary part work must stay keyed.
  let visits = 0;
  const original = projection.state.messagesByID["m-1"];
  Object.defineProperty(projection.state.messagesByID, "m-1", {
    configurable: true,
    get() {
      visits++;
      return original;
    },
  });
  projection.apply({
    op: "part.upsert",
    messageID: "m-1524",
    part: {
      id: "part-m-1524",
      kind: "text",
      synthetic: false,
      blocks: [{ b: "paragraph", inline: [{ i: "text", text: "changed" }] }],
    },
  });
  assertEquals(visits, 0);
  assertStrictEquals(projection.state.messageIDs, ids);
  assertStrictEquals(projection.state.repliesByID["reply:u-1"], unchanged);
  projection.apply({
    op: "message.upsert",
    message: { ...history[1524], cost: 5, parts: [] },
  });
  assertEquals(
    visits,
    0,
    "a usage-only header cannot reconstruct historical queue membership",
  );
  projection.merge([step("earlier", "u-1524", -1)]);
  const reply = projection.state.repliesByID["reply:u-1524"];
  assertEquals(reply.key, "reply:u-1524");
  assertEquals(reply.firstID, "earlier");
  assertEquals(reply.lastID, "m-1524");
  assertEquals(reply.message.parts.map((part) => part.id), [
    "part-earlier",
    "part-m-1524",
  ]);
});
Deno.test("transcript queue changes only on structural/header/status changes and completed replies reject unfinished headers", () => {
  const p = createTranscriptProjection();
  const user = (id: string, created: number): Message => ({
    id,
    sessionID: "tstv1-s",
    role: "user",
    time: { created },
    parts: [],
  });
  p.replace([
    user("prompt", 0),
    { ...step("a"), time: { created: 1 } },
    user("queued", 2),
  ]);
  p.busy(true);
  assertEquals([...p.state.queuedIDs], ["queued"]);
  const queue = p.state.queuedIDs;
  p.apply({
    op: "part.upsert",
    messageID: "a",
    part: { id: "part-a", kind: "text", synthetic: false, blocks: [] },
  });
  assertStrictEquals(p.state.queuedIDs, queue);
  p.apply({ op: "message.upsert", message: step("a") });
  const final = p.state.messagesByID.a;
  p.apply({
    op: "message.upsert",
    message: { ...step("a"), time: { created: 1 } },
  });
  assertStrictEquals(p.state.messagesByID.a, final);
  p.busy(false);
  assertEquals([...p.state.queuedIDs], []);
  p.clear();
  assertEquals(p.state.messageIDs, []);
  assertEquals(p.state.replyIDs, []);
});

Deno.test("a changed segment in a giant reply borrows historical segments without reading their message records", () => {
  const p = createTranscriptProjection();
  p.replace(
    Array.from({ length: 102 }, (_, i) => step(`step-${i}`, "turn", i)),
  );
  let visits = 0;
  const first = p.state.messagesByID["step-0"];
  Object.defineProperty(p.state.messagesByID, "step-0", {
    configurable: true,
    get() {
      visits++;
      return first;
    },
  });
  const old = p.state.repliesByID["reply:turn"].segments[0];
  p.apply({
    op: "part.upsert",
    messageID: "step-101",
    part: { id: "part-step-101", kind: "text", synthetic: false, blocks: [] },
  });
  assertEquals(visits, 0);
  assertStrictEquals(p.state.repliesByID["reply:turn"].segments[0], old);
  const previous = p.state.repliesByID["reply:turn"];
  let segmentVisits = 0;
  const historicalID = previous.segments[0].messageID;
  Object.defineProperty(previous.segments[0], "messageID", {
    configurable: true,
    get() {
      segmentVisits++;
      return historicalID;
    },
  });
  let flattened = 0;
  Object.defineProperty(previous.message, "parts", {
    get() {
      flattened++;
      return [];
    },
  });
  p.apply({
    op: "part.upsert",
    messageID: "step-51",
    part: { id: "part-step-51", kind: "text", synthetic: false, blocks: [] },
  });
  assertEquals(
    flattened,
    0,
    "a middle-segment replacement cannot force the previous grouped parts getter",
  );
  assertEquals(
    segmentVisits,
    0,
    "part replacement uses indexed segment membership without visiting historical segments",
  );
});

Deno.test("the canonical transcript publishes one thousand part replacements without traversing history and lazily copies every missing step", async () => {
  const messages = Array.from(
    { length: 102 },
    (_, i) => ({
      ...step(`step-${String(i).padStart(3, "0")}`, "turn", i),
      parts: [{
        id: `text-${i}`,
        kind: "text" as const,
        synthetic: false,
        blocks: [],
      }],
    }),
  );
  const connection = new SidecarConnection("http://example.test", {
    status() {},
    frame() {},
  }, { messages: fixtureMessagePolicy });
  const calls: unknown[] = [];
  connection.subscribe = () => {};
  connection.supports = () => false;
  connection.rpc.call = (method, params) => {
    if (method !== "session.messages") return Promise.resolve([]) as never;
    calls.push(params);
    return Promise.resolve(
      fixturePage("tstv1-s", messages, (params as { before?: string }).before),
    ) as never;
  };
  const owner = createTranscript(
    { sidecarId: "server", sessionID: "tstv1-s" },
    () => connection,
    () => undefined,
    (read) => read(),
  );
  try {
    owner.temperature("screen");
    for (let i = 0; i < 40; i++) await Promise.resolve();
    assertEquals(owner.state.messageIDs.length, 20);
    assertEquals(
      JSON.parse(JSON.stringify(owner.state.content)).messages.length,
      20,
      "explicit compatibility export retains canonical messages",
    );
    let visits = 0;
    const historyID = owner.state.messageIDs[0],
      history = owner.state.messagesByID[historyID];
    Object.defineProperty(owner.state.messagesByID, historyID, {
      configurable: true,
      get() {
        visits++;
        return history;
      },
    });
    const ids = owner.state.messageIDs;
    for (let i = 1; i <= 1000; i++) {
      owner.receive("server", {
        t: "content",
        sessionID: "tstv1-s",
        clock: {
          epoch: owner.state.clock!.epoch,
          seq: owner.state.clock!.seq + 1,
        },
        event: {
          op: "part.upsert",
          messageID: "step-101",
          part: { id: "text-101", kind: "text", synthetic: false, blocks: [] },
        },
      });
    }
    assertEquals(visits, 0);
    assertStrictEquals(owner.state.messageIDs, ids);
    const result = await owner.source("step-101", (part) => part.id);
    assertEquals(
      result,
      Array.from({ length: 102 }, (_, i) => `text-${i}`).join("\n\n"),
    );
    assertEquals(calls.length, 11);
    owner.temperature("cold");
    assertEquals(owner.state.messageIDs, []);
    assertEquals(owner.state.replyIDs, []);
  } finally {
    owner.stop();
    connection.stop();
  }
});
