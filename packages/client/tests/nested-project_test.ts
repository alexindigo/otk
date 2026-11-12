// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals } from "@std/assert";
import { createProjectProjection } from "../project-projection.ts";
import { createTabs } from "./supervision-fixture.ts";
import type { MergedMetadata } from "../index.ts";
import type { InboxSnapshot, TaskRecord } from "@otk/protocol";

Deno.test("one project owner routes nested members, persisted tasks and promotion through the authoritative leaf", async () => {
  const entry: MergedMetadata = {
    id: "tstv1-nested",
    directory: "/tree/src",
    sidecarId: "local",
    projectID: "repo",
    title: "Nested",
    status: "busy",
    archived: false,
    timeCreated: 1,
    timeUpdated: 2,
    attention: {
      permissions: 0,
      questions: 0,
      childPermissions: 0,
      childQuestions: 0,
    },
  };
  const taskEntry = {
    ...entry,
    id: "tstv1-task",
    title: "Task member",
    status: "idle" as const,
  };
  const entries = new Map([entry, taskEntry].map((e) => [e.id, e]));
  const owner = createProjectProjection({ entry: (id) => entries.get(id) });
  owner.update(entries.keys());
  assertEquals(owner.directories(), ["/tree/src"]);
  const task: TaskRecord = {
    id: "task",
    directory: entry.directory,
    name: "Nested task",
    order: 0,
    sessions: [taskEntry.id],
  };
  const snapshot: InboxSnapshot = {
    projects: [],
    tasks: [task],
    seen: {},
    finishes: {},
    pathTemplates: [],
    summaries: {
      "/tree": {
        directory: "/tree",
        hasSessions: true,
        status: "working",
        sessionCount: 2,
        unseenCount: 0,
        lastActivity: 2,
        authority: "current",
        topology: {
          repoID: "repo",
          canonicalRoot: "/repo",
          leafDirectory: "/tree",
          parentDirectory: "/repo",
        },
        ...{ scopes: ["/tree", "/tree/src"] },
      },
    },
  };
  owner.inbox(snapshot);
  assertEquals(owner.directories(), ["/tree"]);
  assertEquals(owner.input("/tree").entries.map((e) => e.id), [
    entry.id,
    taskEntry.id,
  ]);
  const promoted: string[] = [];
  const tabs = createTabs((session) => {
    promoted.push(session.directory);
    return Promise.resolve({ ...task, id: "promoted", sessions: [session.id] });
  });
  tabs.update(owner.input("/tree"));
  assertEquals(
    new Set(tabs.tabs().map((t) => t.id)),
    new Set([entry.id, task.id]),
  );
  tabs.preview(entry.id);
  assertEquals(tabs.entry(entry.id)?.directory, "/tree/src");
  await tabs.pin(entry.id);
  assertEquals(promoted, ["/tree/src"]);
  assertEquals(snapshot.tasks[0].directory, "/tree/src");
  assertEquals(entry.directory, "/tree/src");
  tabs.stop();
  const summary = snapshot.summaries!["/tree"];
  owner.inbox({
    ...snapshot,
    summaries: {
      "/moved": {
        ...summary,
        directory: "/moved",
        topology: {
          ...summary.topology!,
          leafDirectory: "/moved",
          canonicalRoot: "/new-repo",
          parentDirectory: "/new-repo",
        },
      },
    },
  });
  assertEquals(owner.directories(), ["/moved"]);
  assertEquals(owner.input("/moved").entries.map((e) => e.directory), [
    "/tree/src",
    "/tree/src",
  ]);
  owner.inbox({ ...snapshot, summaries: {} });
  assertEquals(owner.directories(), ["/tree/src"]);
});
