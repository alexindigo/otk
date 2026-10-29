// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals } from "@std/assert";
import { TaskProgress } from "../tasks.ts";
import type { ContentOp } from "@otk/protocol";
import { ready, task } from "./task-fixture.ts";
Deno.test("unavailable helper progress patches all live siblings without parent reads", () => {
  const parents: string[] = [];
  const tracker = new TaskProgress({
    peek: () => undefined,
    request: () => {},
    subscribed: () => true,
    emit: (id) => parents.push(id),
  });
  tracker.shape(task);
  tracker.shape({ ...task, sessionID: "healthy" });
  tracker.update("opcv1-child", {
    state: "unavailable",
    revision: 1,
    toolCount: null,
  });
  assertEquals(parents, ["opcv1-parent", "opcv1-healthy"]);
});
Deno.test("a retired parent and replaced child cannot receive stale progress", () => {
  const events: ContentOp[] = [];
  const tracker = new TaskProgress({
    peek: () => undefined,
    subscribed: () => true,
    emit: (_id, op) => events.push(op),
  });
  tracker.shape(task);
  tracker.release("opcv1-parent");
  tracker.shape({
    ...task,
    state: { ...task.state!, metadata: { sessionId: "replacement" } },
  });
  tracker.update("opcv1-child", ready);
  assertEquals(events, []);
  tracker.update("opcv1-replacement", ready);
  assertEquals(events.length, 1);
});
