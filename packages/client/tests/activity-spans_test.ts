// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals } from "@std/assert";
import type { Activity, Message } from "@otk/protocol";
import { activitySpans, createTranscriptProjection } from "../mod.ts";
import { createRecordProjection } from "../activity-spans.ts";

function record(id: string, activity: Partial<Activity> = {}): Message {
  return {
    id,
    sessionID: "session",
    role: "context",
    time: { created: Number(id.replace(/\D/g, "")) * 1000 },
    parts: [{
      kind: "external",
      id: `part-${id}`,
      name: "invented/record",
      activity: {
        kindLabel: "Permission",
        summary: {
          kind: "permission",
          noun: "permission",
          plural: "permissions",
        },
        title: "Permission once",
        detail: "external_directory",
        layout: "row",
        category: "record",
        tone: "normal",
        ...activity,
      },
    }],
  };
}
function answer(
  id: string,
  replyTo?: string,
): Extract<Message, { role: "assistant" }> {
  return {
    id,
    sessionID: "session",
    role: "assistant",
    replyTo,
    time: { created: Number(id.replace(/\D/g, "")) * 1000, completed: 5000 },
    agent: "build",
    model: { provider: "test", model: "test" },
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    cost: 0,
    interrupted: false,
    parts: [],
  };
}

function group(messages: Message[]) {
  const projection = createTranscriptProjection();
  projection.reset(messages);
  return activitySpans(
    projection.state.replyIDs,
    projection.state.repliesByID,
  );
}

Deno.test("activity breaks partition lookahead, silent completions, and identical records", () => {
  const p = createTranscriptProjection();
  p.reset([
    {
      id: "answer",
      sessionID: "session",
      role: "assistant",
      time: { created: 0, completed: 500 },
      agent: "build",
      model: { provider: "test", model: "test" },
      tokens: {
        input: 0,
        output: 0,
        reasoning: 0,
        cache: { read: 0, write: 0 },
      },
      cost: 0,
      interrupted: false,
      parts: [],
    },
    { ...record("r1"), parts: [] },
    record("r2"),
    record("r3"),
  ]);
  const records = createRecordProjection();
  const value = records.reconcile(
    p.state.replyIDs,
    p.state.repliesByID,
    new Set(["r1", "r2"]),
  );
  assertEquals(value.keys, [
    "reply:answer",
    "r1",
    "activity:r2",
    "activity:r3",
  ]);
  assertEquals(value.groups["activity:r2"].members, ["r2"]);
  assertEquals(value.groups["activity:r3"].members, ["r3"]);
  assertEquals(value.groups["activity:r2"].children?.[0].members, ["r2"]);

  const completion = record("r2", {
    completion: { placement: "footer" },
  });
  p.reset([p.state.messagesByID.answer, completion, record("r3")]);
  const detached = records.reconcile(
    p.state.replyIDs,
    p.state.repliesByID,
    new Set(["reply:answer", "r2"]),
  );
  assertEquals(detached.groups[detached.owners.r2].silent, true);
  assertEquals(detached.groups[detached.owners.r2].completionOf, undefined);
  assertEquals(detached.completions["reply:answer"], undefined);
});

Deno.test("prepending and splitting an activity interval never reuse its live key", () => {
  const projection = createTranscriptProjection();
  const left = record("r1"), right = record("r3");
  projection.reset([right]);
  const [key] = projection.state.records.keys;
  projection.reset([left, right]);
  assertEquals(projection.state.records.keys, [key]);
  projection.reset([
    left,
    { ...record("r2"), role: "user", parts: [] },
    right,
  ]);
  const value = projection.state.records;
  assertEquals(value.keys.length, 3);
  assertEquals(new Set(value.keys).size, 3);
  assertEquals(value.groups[value.owners.r1].members, ["r1"]);
  assertEquals(value.groups[value.owners.r3].members, ["r3"]);
});

Deno.test("activity spans summarize mixed records and preserve every reveal path", () => {
  const value = group([
    record("r1"),
    record("r2"),
    record("r3", {
      kindLabel: "Execution",
      title: "Execution succeeded",
      summary: { kind: "execution", noun: "run", plural: "runs" },
    }),
    record("r4", {
      kindLabel: "System",
      title: "System",
      summary: {
        kind: "system",
        noun: "system update",
        plural: "system updates",
      },
    }),
    record("r5", {
      kindLabel: "Subagent result",
      title: "Junior finished",
      summary: {
        kind: "subagent",
        noun: "helper finished",
        plural: "helpers finished",
      },
    }),
    record("r6", {
      kindLabel: "Shell result",
      title: "Shell finished",
      summary: { kind: "shell", noun: "shell", plural: "shells" },
    }),
  ]);
  assertEquals(value.keys, ["activity:r1"]);
  const span = value.groups["activity:r1"];
  assertEquals(span.members, ["r1", "r2", "r3", "r4", "r5", "r6"]);
  assertEquals(
    span.title,
    "2 permissions, 1 run, 1 system update, 1 helper finished, 1 shell",
  );
  assertEquals(span.time, undefined);
  assertEquals(span.children?.[0].members, ["r1", "r2"]);
  assertEquals(span.children?.[0].count, 2);
  assertEquals(value.parents.r2, ["activity:r1", "records:r1"]);
  assertEquals(value.parents.r6, ["activity:r1"]);
  assertEquals(value.owners.r6, "activity:r1");
});

Deno.test("empty and mixed context records retain shape and count failures across all parts", () => {
  const empty = { ...record("r1"), parts: [] };
  const failure = record("r2", { tone: "error" });
  const mixed = {
    ...failure,
    parts: [
      { kind: "text" as const, id: "text", synthetic: true, blocks: [] },
      ...failure.parts,
    ],
  };
  const value = group([empty, mixed]);
  assertEquals(value.groups["activity:r1"].members, ["r1", "r2"]);
  assertEquals(value.groups["activity:r1"].breakouts, ["r1", "r2"]);
  assertEquals(value.groups["activity:r1"].failureTitle, "1 failed");
});

Deno.test("unsafe records break out inside one interval; conversation separates intervals", () => {
  for (
    const activity of [
      { tone: "error" as const },
      {
        state: {
          key: "opaque",
          label: "Working",
          facts: { active: true, terminal: false },
        },
      },
      {
        state: {
          key: "opaque",
          label: "Needs you",
          facts: { active: false, terminal: false },
        },
      },
    ]
  ) {
    const value = group([
      record("r1"),
      record("r2"),
      record("r3", activity),
      record("r4"),
      record("r5"),
    ]);
    assertEquals(value.keys, ["activity:r1"]);
    assertEquals(value.groups.r3, undefined);
    assertEquals(value.owners.r3, "activity:r1");
    assertEquals(value.groups["activity:r1"].breakouts, ["r3"]);
  }
  const prompt: Message = {
    id: "r3",
    sessionID: "session",
    role: "user",
    time: { created: 3000 },
    parts: [{ kind: "text", id: "text", blocks: [], synthetic: false }],
  };
  assertEquals(
    group([record("r1"), record("r2"), prompt, record("r4"), record("r5")])
      .keys,
    ["activity:r1", "r3", "activity:r4"],
  );
});

Deno.test("boundary between interval members splits the interval", () => {
  const helper = {
    kind: "helper",
    noun: "helper finished",
    plural: "helpers finished",
  };
  const value = group([
    answer("a1"),
    record("r2", { summary: helper }),
    record("r3", {
      summary: { kind: "shell", noun: "shell", plural: "shells" },
    }),
    record("r4", { layout: "boundary", category: "compaction" }),
    record("r5", { summary: helper }),
  ]);
  assertEquals(value.keys, ["reply:a1", "activity:r2", "r4", "activity:r5"]);
  assertEquals(value.owners.r4, "r4");
  assertEquals(
    Object.values(value.groups).map((group) => ({
      members: group.members,
      breakouts: group.breakouts,
      children: group.children?.flatMap((child) => child.members),
    })),
    [
      { members: ["r2", "r3"], breakouts: [], children: ["r2", "r3"] },
      { members: ["r5"], breakouts: [], children: ["r5"] },
    ],
  );
});

Deno.test("boundary alone after a reply", () => {
  const value = group([answer("a1"), record("r2", { layout: "boundary" })]);
  assertEquals(value.keys, ["reply:a1", "r2"]);
  assertEquals(Object.keys(value.groups), []);
  assertEquals(value.completions["reply:a1"], undefined);
});

Deno.test("records after a boundary are not the completion of the reply before it", () => {
  const value = group([
    answer("a1"),
    record("r2", { layout: "boundary" }),
    record("r3", { completion: { placement: "footer" } }),
  ]);
  assertEquals(value.completions["reply:a1"], undefined);
  assertEquals(value.keys, ["reply:a1", "r2", "activity:r3"]);
});

Deno.test("mid-turn compaction follows the grouped reply", () => {
  const projection = createTranscriptProjection();
  projection.reset([
    { ...record("p1"), role: "user", parts: [] },
    answer("a2", "p1"),
    record("r3", { layout: "boundary", category: "compaction" }),
    answer("a4", "p1"),
  ]);
  assertEquals(projection.state.records.keys, ["p1", "reply:p1", "r3"]);
  assertEquals(projection.state.repliesByID["reply:p1"].messageIDs, [
    "a2",
    "a4",
  ]);
});

Deno.test("singletons mint intervals and identical groups do not cross kinds or details", () => {
  assertEquals(group([record("r1")]).keys, ["activity:r1"]);
  const value = group([
    record("r1"),
    record("r2", { detail: "different" }),
    record("r3", { kindLabel: "Other" }),
  ]);
  assertEquals(
    value.groups["activity:r1"].children?.map((row) => row.members),
    [["r1"], ["r2"], ["r3"]],
  );
});
