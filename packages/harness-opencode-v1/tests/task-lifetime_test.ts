// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals } from "@std/assert";
import { TaskProgress } from "../tasks.ts";
import type { ContentOp } from "@otk/protocol";
import { ready, task } from "./task-fixture.ts";
Deno.test("task link upserts coalesce and stop leaves no late publication", async () => {
  const events: ContentOp[] = [];
  const tracker = new TaskProgress({
    peek: () => undefined,
    request: () => {},
    subscribed: () => true,
    emit: (_id, op) => events.push(op),
  });
  tracker.shape(task);
  tracker.shape(task);
  tracker.update("opcv1-child", ready);
  assertEquals(events.length, 1);
  await tracker.stop();
  tracker.update("opcv1-child", { ...ready, revision: 3 });
  assertEquals(events.length, 1);
});
Deno.test("helper patches never rearm work or keep a retired parent alive", () => {
  const events: ContentOp[] = [];
  const tracker = new TaskProgress({
    peek: () => undefined,
    request: () => {},
    subscribed: () => true,
    emit: (_id, op) => events.push(op),
  });
  tracker.shape(task);
  tracker.release("opcv1-parent");
  for (let revision = 1; revision < 100; revision++) {
    tracker.update("opcv1-child", { ...ready, revision });
  }
  assertEquals(events, []);
});
Deno.test("duplicate progress has one publication and a later revision one replacement", () => {
  const events: ContentOp[] = [];
  const tracker = new TaskProgress({
    peek: () => undefined,
    subscribed: () => true,
    emit: (_id, op) => events.push(op),
  });
  tracker.shape(task);
  for (let n = 0; n < 100; n++) tracker.update("opcv1-child", ready);
  tracker.update("opcv1-child", { ...ready, revision: 3 });
  assertEquals(events.length, 2);
});
Deno.test("deleting a child retires every parent link", () => {
  const events: ContentOp[] = [];
  const tracker = new TaskProgress({
    peek: () => undefined,
    subscribed: () => true,
    emit: (_id, op) => events.push(op),
  });
  tracker.shape(task);
  tracker.shape({ ...task, sessionID: "other" });
  tracker.dispose("opcv1-child");
  tracker.update("opcv1-child", ready);
  assertEquals(events, []);
});
