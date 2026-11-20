// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals, assertNotEquals } from "@std/assert";
import type { Activity, Message } from "@otk/protocol";
import {
  createTranscriptInteraction,
  createTranscriptProjection,
} from "../mod.ts";

function record(id: number, facts: Partial<Activity> = {}): Message {
  return {
    id: `r${id}`,
    sessionID: "session",
    role: "context",
    time: { created: id },
    parts: [{
      kind: "external",
      id: `p${id}`,
      name: "invented/fact",
      activity: {
        kindLabel: "Opaque",
        summary: {
          kind: "permission",
          noun: "permission",
          plural: "permissions",
        },
        title: "Permission once",
        category: "record",
        layout: "row",
        tone: "normal",
        ...facts,
      },
    }],
  };
}
const queued: Activity["state"] = {
  key: "queued",
  label: "Queued",
  facts: { active: false, terminal: false },
};
const settled: Activity["state"] = {
  key: "done",
  label: "Done",
  facts: { active: false, terminal: true },
};
const prompt: Message = {
  id: "prompt",
  sessionID: "session",
  role: "user",
  time: { created: 0 },
  parts: [],
};

Deno.test("identical helper folds retain their entity and original child action", () => {
  const p = createTranscriptProjection();
  const facts: Partial<Activity> = {
    entity: { label: "Junior", sessionID: "child" },
    child: { label: "Open task", sessionID: "child" },
    state: settled,
  };
  p.replace([record(1, facts), record(2, facts)]);
  const group = p.state.records.groups[p.state.records.keys[0]].children![0];
  assertEquals(group.count, 2);
  assertEquals(group.entity, facts.entity);
  assertEquals(group.child, facts.child);
});

Deno.test("background interval survives queued admission, singleton append and helper settlement", () => {
  const p = createTranscriptProjection();
  p.replace([prompt, record(1, { state: queued })]);
  const key = p.state.records.keys[1],
    child = p.state.records.groups[key].children![0].key;
  p.apply({
    op: "message.upsert",
    message: record(2, {
      summary: {
        kind: "helper",
        noun: "helper finished",
        plural: "helpers finished",
      },
      entity: { label: "Junior", sessionID: "child" },
      child: { label: "Open task", sessionID: "child" },
      state: queued,
    }),
  });
  p.apply({ op: "message.upsert", message: record(3) });
  p.apply({ op: "message.upsert", message: record(1, { state: settled }) });
  p.apply({
    op: "message.upsert",
    message: record(2, {
      summary: {
        kind: "helper",
        noun: "helper finished",
        plural: "helpers finished",
      },
      entity: { label: "Junior", sessionID: "child" },
      child: { label: "Open task", sessionID: "child" },
      state: settled,
    }),
  });
  assertEquals(p.state.records.keys, ["prompt", key]);
  assertEquals(p.state.records.groups[key].members, ["r1", "r2", "r3"]);
  assertEquals(p.state.records.groups[key].children![0].key, child);
  assertEquals(p.state.records.groups[key].breakouts, []);
  assertEquals(
    p.state.records.groups[key].title,
    "2 permissions, 1 helper finished",
  );
  const interaction = createTranscriptInteraction();
  interaction.reveal(p.state.records.parents.r2);
  assertEquals(
    interaction.disclosure(key, interaction.generation(key)).expanded("record"),
    true,
  );
  p.replace(p.messages());
  assertEquals(p.state.records.keys, ["prompt", key]);
});
Deno.test("failure breakout and rejoin change child presentation, never the interval partition", () => {
  const p = createTranscriptProjection();
  p.replace([record(1), record(2), record(3)]);
  const key = p.state.records.keys[0], before = p.state.records.revisions[key];
  p.apply({ op: "message.upsert", message: record(2, { tone: "error" }) });
  assertEquals(p.state.records.keys, [key]);
  assertEquals(p.state.records.groups[key].breakouts, ["r2"]);
  assertEquals(
    p.state.records.groups[key].children?.map((child) => child.members),
    [["r1"], ["r2"], ["r3"]],
  );
  assertEquals(p.state.records.owners.r2, key);
  assertNotEquals(p.state.records.revisions[key], before);
  p.apply({ op: "message.upsert", message: record(2) });
  assertEquals(p.state.records.keys, [key]);
  assertEquals(p.state.records.groups[key].breakouts, []);
  assertEquals(p.state.records.groups[key].children![0].members, [
    "r1",
    "r2",
    "r3",
  ]);
});
Deno.test("failed helpers share one summary and frame, without successful run fragments", () => {
  const p = createTranscriptProjection();
  const run: Partial<Activity> = {
    summary: { kind: "execution", noun: "run", plural: "runs" },
    completion: { placement: "footer" },
    state: settled,
  };
  const failed: Partial<Activity> = {
    summary: {
      kind: "helper-failure",
      noun: "helper failed",
      plural: "helpers failed",
    },
    tone: "error",
    state: settled,
    child: { sessionID: "child", label: "Open task" },
  };
  p.replace([
    record(1, run),
    record(2, failed),
    record(3, run),
    record(4, failed),
    record(5, run),
  ]);
  const [key] = p.state.records.keys, group = p.state.records.groups[key];
  assertEquals(p.state.records.keys, [key]);
  assertEquals(group.failureTitle, "2 helpers failed");
  assertEquals(group.breakouts, ["r2", "r4"]);
  assertEquals(group.children?.flatMap((child) => child.members), [
    "r1",
    "r2",
    "r3",
    "r4",
    "r5",
  ]);
  for (const id of group.members) {
    assertEquals(p.state.records.parents[id], [key]);
  }
});
Deno.test("success-only interval is silent, retains source and borrows the preceding reply footer", () => {
  const reply: Message = {
    id: "reply",
    sessionID: "session",
    role: "assistant",
    time: { created: 0, completed: 1 },
    agent: "build",
    model: { provider: "test", model: "test" },
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    cost: 0,
    interrupted: false,
    parts: [],
  };
  const p = createTranscriptProjection();
  p.replace([
    reply,
    record(2, { completion: { placement: "footer" }, state: settled }),
  ]);
  const key = p.state.records.keys[1];
  assertEquals(p.state.records.groups[key].silent, true);
  assertEquals(p.state.records.completions["reply:reply"], key);
  assertEquals(p.state.records.parents.r2, [key]);
  assertEquals(p.state.repliesByID.r2.message.parts.length, 1);
  p.apply({ op: "message.upsert", message: record(3) });
  assertEquals(p.state.records.groups[key].silent, false);
});
Deno.test("older page and ordinary updates preserve interval and measurement revisions", () => {
  const p = createTranscriptProjection();
  p.replace([record(3)]);
  const key = p.state.records.keys[0];
  p.merge([record(1), record(2)]);
  assertEquals(p.state.records.keys, [key]);
  const revision = p.state.records.revisions[key];
  p.busy(true);
  p.busy(false);
  assertEquals(p.state.records.revisions[key], revision);
});
