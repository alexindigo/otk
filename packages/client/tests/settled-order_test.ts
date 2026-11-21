// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals } from "@std/assert";
import { createSettledOrder } from "../settled-order.ts";

Deno.test("project recency traffic settles independently and never moves a hovered row", () => {
  let now = 0, sequence = 0, changes = 0;
  const timers = new Map<number, { due: number; run(): void }>();
  const owner = createSettledOrder<{ id: string; activity: number }>(
    () => changes++,
    {
      clock: {
        now: () => now,
        set(run, ms) {
          timers.set(++sequence, { due: now + ms, run });
          return sequence;
        },
        clear(id) {
          timers.delete(id as number);
        },
      },
    },
  );
  const rows = [{ id: "a", activity: 2 }, { id: "b", activity: 1 }];
  const order = () =>
    owner.order(rows, (row) => ({ priority: 1, activity: row.activity })).map(
      (row) => row.id,
    );
  const tick = (ms: number) => {
    now += ms;
    for (const [id, timer] of timers) {
      if (timer.due <= now) {
        timers.delete(id);
        timer.run();
      }
    }
  };
  try {
    assertEquals(order(), ["a", "b"]);
    for (let i = 0; i < 10; i++) {
      rows[1].activity = i + 10;
      order();
      tick(1000);
      assertEquals(order(), ["a", "b"]);
    }
    const release = owner.hold();
    tick(5000);
    assertEquals(order(), ["a", "b"]);
    release();
    assertEquals(order(), ["b", "a"]);
    assertEquals(changes, 2);
  } finally {
    owner.stop();
  }
});

Deno.test("an urgent new row is appended during a hold, without displacing pointer targets", () => {
  const owner = createSettledOrder<{ id: string; priority: number }>(() => {});
  const a = { id: "a", priority: 2 },
    b = { id: "b", priority: 2 },
    urgent = { id: "urgent", priority: 0 };
  const facts = (row: typeof a) => ({
    priority: row.priority,
    activity: 0,
    urgentMs: 0,
  });
  try {
    assertEquals(owner.order([a, b], facts).map((row) => row.id), ["a", "b"]);
    const release = owner.hold();
    assertEquals(owner.order([urgent, a, b], facts).map((row) => row.id), [
      "a",
      "b",
      "urgent",
    ]);
    release();
    assertEquals(owner.order([urgent, a, b], facts).map((row) => row.id), [
      "urgent",
      "a",
      "b",
    ]);
  } finally {
    owner.stop();
  }
});
