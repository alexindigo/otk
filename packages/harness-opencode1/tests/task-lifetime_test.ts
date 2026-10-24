// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals } from "@std/assert";
import { TaskProgress } from "../tasks.ts";
import type { NativeMessage } from "../messages.ts";
import type { RawPart } from "../types.ts";

const raw: RawPart = {
  id: "part",
  sessionID: "parent",
  messageID: "message",
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
Deno.test("task scans coalesce and release aborts and joins their actual completion", async () => {
  const held = Promise.withResolvers<NativeMessage[]>(),
    signals: (AbortSignal | undefined)[] = [];
  const tracker = new TaskProgress(
    (_id, _message, signal) => {
      signals.push(signal);
      return held.promise;
    },
    () => true,
    () => {},
    () => {},
  );
  const first = tracker.shape(raw), second = tracker.shape(raw);
  let stopped = false;
  let stop: Promise<void> | undefined;
  try {
    assertEquals(signals.length, 1, "Initial child scans overlap");
    stop = tracker.stop().then(() => {
      stopped = true;
    });
    assert(signals[0]?.aborted, "Release did not cancel the scan");
    assertEquals(stopped, false);
  } finally {
    held.resolve([]);
    await Promise.allSettled([first, second, stop]);
  }
  assertEquals(stopped, true);
});
Deno.test("task refresh coalesces events while a parent read is held", async () => {
  const entered = Promise.withResolvers<void>(),
    held = Promise.withResolvers<NativeMessage[]>();
  let reads = 0, signal: AbortSignal | undefined;
  const tracker = new TaskProgress(
    (_id, message, abort) => {
      if (!message) return Promise.resolve([]);
      reads++;
      signal = abort;
      entered.resolve();
      return held.promise;
    },
    () => true,
    () => {},
    () => {},
  );
  try {
    await tracker.shape(raw);
    tracker.observe("child");
    await entered.promise;
    tracker.observe("child");
    tracker.release("parent");
    assert(signal?.aborted, "Retired parent read was not aborted");
    held.resolve([]);
    await tracker.stop();
    assertEquals(reads, 1, "Retired child scheduled more work");
  } finally {
    held.resolve([]);
    tracker.release();
  }
});
Deno.test("task refresh has one in-flight read and exactly one trailing dirty refresh", async () => {
  const jobs = new Map<number, () => void>();
  let next = 0, reads = 0;
  const entered = Promise.withResolvers<void>(),
    held = Promise.withResolvers<NativeMessage[]>(),
    trailing = Promise.withResolvers<void>(),
    delivered = Promise.withResolvers<void>();
  const tracker = new TaskProgress(
    (_id, message) => {
      if (!message) return Promise.resolve([]);
      if (++reads === 1) {
        entered.resolve();
        return held.promise;
      }
      return Promise.resolve([{
        info: {
          id: "message",
          sessionID: "parent",
          role: "user",
          time: { created: 1 },
        },
        parts: [raw],
      }]);
    },
    () => true,
    () => delivered.resolve(),
    () => {},
    {
      schedule(run, milliseconds) {
        assertEquals(milliseconds, 50);
        const id = ++next;
        jobs.set(id, run);
        if (next === 2) trailing.resolve();
        return () => {
          jobs.delete(id);
        };
      },
    },
  );
  const fire = () => {
    const [id, run] = jobs.entries().next().value!;
    jobs.delete(id);
    run();
  };
  try {
    await tracker.shape(raw);
    tracker.observe("child");
    fire();
    await entered.promise;
    for (let n = 0; n < 100; n++) tracker.observe("child");
    assertEquals(jobs.size, 0, "Events scheduled overlapping reads");
    held.resolve([]);
    await trailing.promise;
    assertEquals(jobs.size, 1);
    fire();
    await delivered.promise;
    await tracker.stop();
    assertEquals(reads, 2);
    assertEquals(jobs.size, 0);
  } finally {
    held.resolve([]);
    await tracker.stop();
  }
});
Deno.test("deleting a task child aborts its scan even while the parent remains subscribed", async () => {
  const held = Promise.withResolvers<NativeMessage[]>();
  let signal: AbortSignal | undefined;
  const tracker = new TaskProgress(
    (_id, _message, abort) => {
      signal = abort;
      return held.promise;
    },
    () => true,
    () => {},
    () => {},
  );
  const shape = tracker.shape(raw);
  try {
    tracker.dispose("child");
    assert(signal?.aborted);
  } finally {
    held.resolve([]);
    await shape;
    await tracker.stop();
  }
});
