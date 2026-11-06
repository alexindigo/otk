// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals } from "@std/assert";
import { taskBreadcrumbs } from "@otk/client";
import type { IndexEntry } from "@otk/protocol";
Deno.test("breadcrumbs keep member order, include active nested helpers and cannot duplicate grouped children or cycles", () => {
  const make = (id: string, parentID?: string): IndexEntry => ({
    id,
    parentID,
    directory: "/p",
    projectID: "p",
    title: id,
    timeCreated: 1,
    timeUpdated: 1,
    archived: false,
    status: "busy",
    digest: { state: "digesting", revision: 0, turns: {} },
    attention: {
      permissions: 0,
      questions: 0,
      childPermissions: 0,
      childQuestions: 0,
    },
  });
  const task = {
    id: "task",
    directory: "/p",
    name: "exec",
    order: 0,
    sessions: ["a", "b"],
  };
  const entries = [
    make("a"),
    make("helper", "a"),
    make("nested", "helper"),
    make("b", "a"),
  ];
  assertEquals(
    taskBreadcrumbs(task, entries).map((c) => [c.id, c.depth]),
    [["a", 0], ["helper", 1], ["nested", 2], ["b", 0]],
  );
  assertEquals(taskBreadcrumbs(task, entries).map((c) => c.id), [
    "a",
    "helper",
    "nested",
    "b",
  ]);
  entries[0].parentID = "nested";
  assertEquals(
    new Set(taskBreadcrumbs(task, entries).map((c) => c.id)).size,
    4,
  );
});
