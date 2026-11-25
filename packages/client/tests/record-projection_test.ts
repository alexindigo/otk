// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals, assertNotEquals } from "@std/assert";
import type { Activity, Message } from "@otk/protocol";
import {
  createTranscriptInteraction,
  createTranscriptProjection,
  createWindow,
} from "../mod.ts";

function record(
  id: number,
  activity: Partial<Activity> = {},
  data = "same",
): Message {
  return {
    id: `r${id}`,
    sessionID: "session",
    role: "context",
    time: { created: id },
    parts: [{
      kind: "external",
      id: `p${id}`,
      name: "plugin/record",
      data,
      activity: {
        kindLabel: "Opaque",
        summary: { kind: "plugin/run", noun: "run", plural: "runs" },
        title: "Same title",
        category: "record",
        layout: "row",
        tone: "normal",
        ...activity,
      },
    }],
  };
}
Deno.test("record projection mints singleton spans and preserves append topology", () => {
  const p = createTranscriptProjection();
  p.replace([record(1)]);
  const first = p.state.records;
  const key = first.keys[0], child = first.groups[key].children![0].key;
  assertNotEquals(key, "r1");
  assertEquals(first.groups[key].members, ["r1"]);
  for (let id = 2; id <= 15; id++) {
    p.apply({ op: "message.upsert", message: record(id) });
  }
  const next = p.state.records;
  assertEquals(next.keys, [key]);
  assertEquals(next.groups[key].children![0].key, child);
  assertEquals(next.groups[key].members.length, 15);
  assert(next.groups[key].revision > first.groups[key].revision);
  assertEquals(next.groups[key].detail, "15 runs");
  p.apply({
    op: "message.upsert",
    message: record(16, { direction: "outgoing" }),
  });
  assertEquals(p.state.records.keys, [key, "activity:r16"]);
  assertEquals(p.state.records.groups["activity:r16"].direction, "outgoing");
  p.replace([]);
  p.replace([record(15)]);
  assertEquals(p.state.records.keys, [key]);
  p.merge(Array.from({ length: 14 }, (_, n) => record(n + 1)));
  assertEquals(p.state.records.keys, [key]);
  assertEquals(p.state.records.groups[key].members.length, 15);
  const cache = new Map<string, number>();
  let extentRevision = 1;
  const window = createWindow(cache, (key) => `${key}:${extentRevision}`);
  window.update([key], () => 26);
  window.measure(key, 100);
  extentRevision++;
  assertEquals(window.measured(key), false);
  window.update([key], () => 26);
  assertEquals(window.size(key), 26);
  window.measure(key, 200);
  assertEquals([...cache.keys()], [`${key}:2`]);
});
Deno.test("terminal transitions never replace an existing individual row", () => {
  const p = createTranscriptProjection();
  p.replace([
    record(1),
    record(2, {
      state: {
        key: "busy",
        label: "Busy",
        facts: { active: true, terminal: false },
      },
    }),
  ]);
  const keys = [...p.state.records.keys];
  p.apply({ op: "message.upsert", message: record(2) });
  p.apply({ op: "message.upsert", message: record(3) });
  assertEquals(p.state.records.keys.slice(0, 2), keys);
  assertEquals(p.state.records.owners.r2, "r2");
  p.replace(p.messages());
  assertEquals(p.state.records.keys.slice(0, 2), keys);
});
Deno.test("failure breaks out and full record facts prevent title-only folding", () => {
  const p = createTranscriptProjection();
  p.replace([
    record(1),
    record(2, {}, "different facts"),
    record(3),
    record(4),
  ]);
  const key = p.state.records.keys[0];
  assertEquals(p.state.records.groups[key].children?.length, 3);
  p.apply({ op: "message.upsert", message: record(2, { tone: "error" }) });
  assertEquals(p.state.records.owners.r2, "r2");
  assertEquals(p.state.records.groups[key].members, ["r1"]);
  assert(p.state.records.keys.includes("r2"));
  assertEquals(p.state.records.keys, [key, "r2", "activity:r3"]);
  assertEquals(p.state.records.groups["activity:r3"].members, ["r3", "r4"]);
  assertNotEquals(p.state.records.parents.r1[1], p.state.records.parents.r3[1]);
});
Deno.test("record reveal opens retained ancestry through the interaction owner", () => {
  const p = createTranscriptProjection(),
    interaction = createTranscriptInteraction();
  p.replace([record(1), record(2)]);
  const ancestry = p.state.records.parents.r2;
  interaction.reveal(ancestry);
  for (const key of ancestry) {
    const choice = interaction.disclosure(key, interaction.generation(key));
    assertEquals(choice.expanded("record"), true);
    choice.set(false);
    assertEquals(
      interaction.disclosure(key, interaction.generation(key)).expanded(
        "record",
      ),
      false,
    );
  }
});

Deno.test("a changed middle record splits identical folds without reordering source", () => {
  const p = createTranscriptProjection();
  p.replace([record(1), record(2), record(3), record(4)]);
  const key = p.state.records.keys[0];
  p.apply({ op: "message.upsert", message: record(2, {}, "changed facts") });
  assertEquals(
    p.state.records.groups[key].children?.map((row) => row.members),
    [
      ["r1"],
      ["r2"],
      ["r3", "r4"],
    ],
  );
  const children = p.state.records.groups[key].children!.map((row) => row.key);
  p.replace(p.messages());
  p.apply({ op: "message.upsert", message: record(5) });
  assertEquals(
    p.state.records.groups[key].children!.map((row) => row.key),
    children,
  );
  assertEquals(
    p.state.records.groups[key].children?.flatMap((row) => row.members),
    ["r1", "r2", "r3", "r4", "r5"],
  );
});

Deno.test("ordinary streamed rows publish new measurement revisions without regrouping", () => {
  const p = createTranscriptProjection();
  p.replace([{
    id: "r1",
    sessionID: "session",
    role: "assistant",
    parts: [],
    time: { created: 1 },
    agent: "build",
    model: { provider: "test", model: "test" },
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    cost: 0,
    interrupted: false,
  }]);
  const key = p.state.records.keys[0], before = p.state.records.revisions[key];
  p.apply({
    op: "part.upsert",
    messageID: "r1",
    part: {
      kind: "text",
      id: "p1",
      synthetic: false,
      blocks: [{
        b: "paragraph",
        inline: [{ i: "text", text: "Streamed output" }],
      }],
    },
  });
  assertEquals(p.state.records.keys, [key]);
  assertNotEquals(p.state.records.revisions[key], before);
});

Deno.test("records without producer summary facts remain individually visible", () => {
  const p = createTranscriptProjection();
  p.replace([
    record(1, { summary: undefined }),
    record(2, { summary: undefined }),
  ]);
  assertEquals(p.state.records.keys, ["r1", "r2"]);
});
