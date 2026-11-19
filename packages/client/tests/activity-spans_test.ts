// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals } from "@std/assert";
import type { Activity, Message } from "@otk/protocol";
import { activitySpans, createTranscriptProjection } from "../mod.ts";

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
function group(messages: Message[]) {
  const projection = createTranscriptProjection();
  projection.replace(messages);
  return activitySpans(
    projection.state.replyIDs,
    projection.state.repliesByID,
  );
}

Deno.test("activity spans summarize mixed records and preserve every reveal path", () => {
  const value = group([
    record("r1"),
    record("r2"),
    record("r3", { kindLabel: "Execution", title: "Execution succeeded" }),
    record("r4", { kindLabel: "System", title: "System" }),
    record("r5", { kindLabel: "Subagent result", title: "Junior finished" }),
    record("r6", { kindLabel: "Shell result", title: "Shell finished" }),
  ]);
  assertEquals(value.keys, ["r1"]);
  const span = value.groups.r1;
  assertEquals(span.members, ["r1", "r2", "r3", "r4", "r5", "r6"]);
  assertEquals(
    span.detail,
    "2 permissions · 1 run · 1 system update · 1 helper finished · 1 shell",
  );
  assertEquals(span.time, { first: 1000, last: 6000 });
  assertEquals(span.children?.[0].members, ["r1", "r2"]);
  assertEquals(span.children?.[0].count, 2);
  assertEquals(value.parents.r2, ["r1", "records:r1"]);
  assertEquals(value.parents.r6, ["r1"]);
  assertEquals(value.owners.r6, "r1");
});

Deno.test("conversation and unsafe records split spans without hiding failures or waits", () => {
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
      { layout: "boundary" as const },
    ]
  ) {
    const value = group([
      record("r1"),
      record("r2"),
      record("r3", activity),
      record("r4"),
      record("r5"),
    ]);
    assertEquals(value.keys, ["r1", "r3", "r4"]);
    assertEquals(value.groups.r3, undefined);
    assertEquals(value.owners.r3, "r3");
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
    ["r1", "r3", "r4"],
  );
});

Deno.test("singletons keep their own row and identical groups do not cross kinds or details", () => {
  assertEquals(group([record("r1")]).groups, Object.create(null));
  const value = group([
    record("r1"),
    record("r2", { detail: "different" }),
    record("r3", { kindLabel: "Other" }),
  ]);
  assertEquals(value.groups.r1.children?.map((row) => row.members), [["r1"], [
    "r2",
  ], ["r3"]]);
});
