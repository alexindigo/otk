// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals } from "@std/assert";
import { TaskProgress } from "../tasks.ts";
import type { ContentOp } from "@otk/protocol";
import { ready, task } from "./task-fixture.ts";
Deno.test("task retains native result and completion clock while borrowing helper progress", () => {
  const events: ContentOp[] = [];
  const tracker = new TaskProgress({
    peek: () => ready,
    subscribed: () => true,
    emit: (_id, op) => events.push(op),
  });
  const shaped = tracker.shape(task);
  assertEquals(shaped.agent, "general");
  assertEquals(shaped.description, "Inspection");
  assertEquals(shaped.output, "Native result");
  assertEquals(shaped.time.end, 5);
  assertEquals(shaped.progress, ready);
  assert(!("parts" in shaped));
  tracker.update("opcv1-child", { ...ready, revision: 3 });
  assertEquals(events.length, 1);
  assertEquals(events[0].op, "task.progress");
  tracker.release("opcv1-parent");
  tracker.update("opcv1-child", { ...ready, revision: 4 });
  assertEquals(events.length, 1);
});
Deno.test("unsubscribed pages decorate without retaining progress ownership", () => {
  const events: ContentOp[] = [];
  const tracker = new TaskProgress({
    peek: () => ready,
    subscribed: () => false,
    emit: (_id, op) => events.push(op),
  });
  assertEquals(tracker.shape(task).progress, ready);
  tracker.update("opcv1-child", { ...ready, revision: 3 });
  assertEquals(events, []);
});
