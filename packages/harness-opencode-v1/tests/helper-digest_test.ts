// SPDX-License-Identifier: LGPL-3.0-only
import { knownDerived } from "@otk/protocol";
import { assert, assertEquals } from "@std/assert";
import { TaskProgress } from "../tasks.ts";
import type { ContentOp, HelperSummary } from "@otk/protocol";
import type { RawPart } from "../types.ts";

const raw: RawPart = {
  id: "task",
  messageID: "message",
  sessionID: "parent",
  type: "tool",
  tool: "task",
  callID: "call",
  state: {
    status: "running",
    input: {},
    metadata: { sessionId: "child" },
    time: { start: 1 },
  },
};
Deno.test("helper shape is synchronous, source-free and publishes narrow deduplicated progress without reads", () => {
  const emitted: ContentOp[] = [], hints: string[] = [];
  const progress: { value?: HelperSummary } = {};
  const tracker = new TaskProgress({
    peek: () => progress.value,
    request: (id) => hints.push(id),
    subscribed: () => true,
    emit: (_id, op) => emitted.push(op),
  });
  const shaped = tracker.shape(raw);
  assert(!(shaped instanceof Promise), "Parent page waits for helper shaping");
  assertEquals(shaped.progress, {
    state: "digesting",
    revision: 0,
    progress: { state: "pending" },
  });
  assertEquals(hints, ["opcv1-child"]);
  const summary = progress.value = {
    state: "ready",
    revision: 2,
    progress: knownDerived(
      {
        toolCount: 600,
        current: { name: "bash", title: "Tool 1197" },
        time: { start: 1, end: 20 },
      },
      "child",
      2,
    ),
  };
  tracker.update("opcv1-child", summary);
  tracker.update("opcv1-child", summary);
  assertEquals(emitted, [{
    op: "task.progress",
    messageID: "message",
    partID: "task",
    childSessionID: "opcv1-child",
    summary,
  }]);
  tracker.release("opcv1-parent");
  tracker.update("opcv1-child", { ...summary, revision: 3 });
  assertEquals(emitted.length, 1);
});

Deno.test("helper link replacement, removals, cutoff and child retirement fence later patches", () => {
  const emitted: ContentOp[] = [];
  const tracker = new TaskProgress({
    peek: () => undefined,
    request: () => {},
    subscribed: () => true,
    emit: (_id, op) => emitted.push(op),
  });
  const ready: HelperSummary = {
    state: "ready",
    revision: 1,
    progress: knownDerived({ toolCount: 0 }, "child", 1),
  };
  tracker.shape(raw);
  tracker.shape({
    ...raw,
    state: { ...raw.state!, metadata: { sessionId: "other" } },
  });
  tracker.update("opcv1-child", ready);
  assertEquals(emitted.length, 0);
  tracker.remove("opcv1-parent", "message", "task");
  tracker.update("opcv1-other", ready);
  assertEquals(emitted.length, 0);
  tracker.shape(raw);
  tracker.cutoff("opcv1-parent", "message");
  tracker.update("opcv1-child", ready);
  assertEquals(emitted.length, 0);
  tracker.shape(raw);
  tracker.dispose("opcv1-child");
  tracker.update("opcv1-child", ready);
  assertEquals(emitted.length, 0);
});
