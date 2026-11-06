// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals } from "@std/assert";
import { ProjectSummaries } from "../../../core/index/project-summaries.ts";
import type { IndexMetadata, ProjectSummary } from "@otk/protocol";

const entry = (id = "tstv1-a"): IndexMetadata => ({
  id,
  directory: "/other",
  projectID: "p",
  title: id,
  timeCreated: 1,
  timeUpdated: 2,
  archived: false,
  status: "idle",
  attention: {
    permissions: 0,
    questions: 0,
    childPermissions: 0,
    childQuestions: 0,
  },
});
Deno.test("project summaries own status priority, persisted marks, recency and unavailable authority without digest", () => {
  let seen = 0, finish = 0;
  const emitted: ProjectSummary[] = [];
  const owner = new ProjectSummaries(
    (id) => id === "tstv1-a" ? ({ seen, finish }) : ({ seen: 0, finish: 0 }),
    (s) => emitted.push(s),
  );
  owner.ensure("/empty");
  assertEquals(owner.values.get("/empty")?.sessionCount, null);
  owner.authority("current");
  assertEquals(owner.values.get("/empty")?.sessionCount, 0);
  const a = entry();
  owner.entry({ ...a, status: "busy" });
  assertEquals(owner.values.get("/other")?.status, "working");
  finish = 3;
  owner.entry(a);
  assertEquals(owner.values.get("/other")?.status, "finished");
  owner.entry({ ...entry("tstv1-b"), status: "busy" });
  assertEquals(owner.values.get("/other")?.status, "finished");
  owner.entry({ ...a, attention: { ...a.attention, questions: 1 } });
  assertEquals(owner.values.get("/other")?.status, "blocked");
  seen = 4;
  owner.mark(a.id);
  owner.entry(a);
  assertEquals(owner.values.get("/other")?.unseenCount, 0);
  assertEquals(owner.values.get("/other")?.status, "working");
  owner.authority("stale");
  assertEquals(owner.values.get("/other")?.authority, "stale");
  owner.remove("tstv1-b");
  assertEquals(owner.values.get("/other")?.sessionCount, 1);
  assertEquals(owner.values.get("/other")?.status, "idle");
  const before = emitted.length;
  owner.entry(a);
  assertEquals(emitted.length, before);
});
