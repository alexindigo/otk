// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals, assertThrows } from "@std/assert";
import type { Message, MessagePage } from "@otk/protocol";
import { createAcquiredRange } from "../acquired-range.ts";

const messages = (...positions: number[]): Message[] =>
  positions.map((n) => ({
    id: `m${n}`,
    sessionID: "session",
    role: "user",
    time: { created: n },
    parts: [],
  }));
const page = (
  older: string | null,
  ...positions: number[]
) => ({ items: messages(...positions), older } satisfies Partial<MessagePage>);
const same = { same: true };
const changed = { same: false };

Deno.test("overlap joins the head to its acquired cursor chain", () => {
  const coverage = createAcquiredRange();
  coverage.head(page("b8", 8, 9), [], changed);
  coverage.extend("range:m9", "b8", "b6", messages(6, 7));
  assertEquals(coverage.head(page("b9", 9, 10), messages(6, 7, 8, 9), same), {
    joined: true,
    deleted: [],
  });
  assertEquals(coverage.ranges(), [
    { key: "range:m10", first: "m6", last: "m10", next: "b6" },
  ]);
  assertEquals(coverage.next, "b6");
  assertEquals(coverage.gaps(), []);
  assertEquals(coverage.current("m6"), true);
  assertEquals(coverage.current("m10"), true);
});

Deno.test("only the same authority can join by cursor adjacency", () => {
  for (const authority of [same, changed]) {
    const coverage = createAcquiredRange();
    coverage.head(page("b8", 8, 9), [], changed);
    coverage.extend("range:m9", "b8", "b6", messages(6, 7));
    const held = messages(6, 7, 8, 9);
    assertEquals(coverage.head(page("b8", 10, 11), held, authority), {
      joined: authority.same,
      deleted: [],
    });
    assertEquals(coverage.known("m6"), true);
    assertEquals(coverage.current("m6"), authority.same);
    assertEquals(coverage.next, authority.same ? "b6" : undefined);
    assertEquals(
      coverage.gaps(),
      authority.same ? [] : [
        { key: "gap:m9", newer: "m10", older: "m9" },
      ],
    );
  }
});

Deno.test("a bridge joins on an acquired cursor and reuses native exhaustion", () => {
  const coverage = createAcquiredRange();
  coverage.head(page("b3", 3, 4), [], changed);
  coverage.extend("range:m4", "b3", null, messages(1, 2));
  coverage.head(page("b9", 9, 10), messages(1, 2, 3, 4), same);
  assertEquals(coverage.extend("range:m10", "b9", "b3", messages(5, 6, 7, 8)), {
    joined: true,
    deleted: [],
  });
  assertEquals(coverage.gaps(), []);
  assertEquals(coverage.next, null);
  assertEquals(coverage.current("m1"), true);
});

Deno.test("an authority change keeps IDs and exhaustion but retires cursors and their proof", () => {
  const coverage = createAcquiredRange();
  coverage.head(page(null, 1, 2), [], changed);
  coverage.head(page("b5", 5, 6), messages(1, 2), same);
  coverage.head(page("b8", 8, 9), messages(1, 2, 5, 6), changed);
  assertEquals(coverage.ranges(), [
    { key: "range:m9", first: "m8", last: "m9", next: "b8" },
    { key: "range:m6", first: "m5", last: "m6", next: undefined },
    { key: "range:m2", first: "m1", last: "m2", next: null },
  ]);
  assertEquals(coverage.gaps().map((gap) => gap.key), ["gap:m6", "gap:m2"]);
  assertEquals(coverage.known("m1"), true);
  assertEquals(coverage.current("m1"), false);
  assertEquals(coverage.current("m6"), false);
  assertEquals(coverage.current("m9"), true);
  assertEquals(coverage.next, undefined);
});

Deno.test("a changed head joins by ID without certifying its old prefix", () => {
  const coverage = createAcquiredRange();
  coverage.head(page(null, 1, 2, 3), [], changed);
  const held = messages(1, 2, 3);
  assertEquals(coverage.head(page("b3", 3, 4), held, changed), {
    joined: true,
    deleted: [],
  });
  assertEquals(coverage.gaps(), []);
  assertEquals(coverage.next, "b3");
  assertEquals(coverage.known("m2"), true);
  assertEquals(coverage.current("m2"), false);
  coverage.extend("range:m4", "b3", null, messages(1, 2));
  assertEquals(coverage.current("m2"), true);
  assertEquals(coverage.next, null);
});

Deno.test("only absent committed IDs within closed head coverage are deleted", () => {
  const coverage = createAcquiredRange();
  const held = messages(1, 2, 3, 4, 5, 6);
  coverage.head(page("b1", 1, 2, 3, 4, 5), [], changed);
  assertEquals(coverage.head(page("b3", 3, 5), held, same).deleted, [
    "m4",
    "m6", // Live committed row: not previously part of a page link.
  ]);
  assertEquals(coverage.known("m4"), false);
  assertEquals(coverage.current("m4"), false);
  assertEquals(coverage.known("m1"), true);
  assertEquals(coverage.head(page(null, 3), held, changed).deleted, [
    "m1",
    "m2",
    "m4",
    "m5",
    "m6",
  ]);
  assertEquals(
    coverage.head(page(null), held, changed).deleted,
    held.map((m) => m.id),
  );
  assertEquals(coverage.ranges(), []);
  assertEquals(coverage.gaps(), []);
  assertEquals(coverage.next, null);
  coverage.clear();
  assertEquals(coverage.next, undefined);
});

Deno.test("a bridge grows without timestamp-only joining and keeps its gap key until overlap", () => {
  const coverage = createAcquiredRange();
  coverage.head(page("b1", 1, 2, 3), [], changed);
  coverage.head(page("b9", 9, 10), messages(1, 2, 3), same);
  assertEquals(coverage.gaps(), [{ key: "gap:m3", newer: "m9", older: "m3" }]);
  assertEquals(coverage.next, undefined);
  assertThrows(() => coverage.extend("range:m10", "wrong", null, []));
  assertEquals(coverage.extend("range:m10", "b9", "b6", messages(6, 7, 8)), {
    joined: false,
    deleted: [],
  });
  assertEquals(coverage.gaps(), [{ key: "gap:m3", newer: "m6", older: "m3" }]);
  assertEquals(coverage.extend("range:m10", "b6", "b3", messages(3, 4, 5)), {
    joined: true,
    deleted: [],
  });
  assertEquals(coverage.next, "b1");
  assertEquals(coverage.gaps(), []);
});

Deno.test("bridge deletion respects its exclusive upper boundary and an exhausted lower bound", () => {
  const coverage = createAcquiredRange();
  coverage.head(page(null, 1, 2, 3, 4, 5), [], changed);
  coverage.head(page("b8", 8, 9), messages(1, 2, 3, 4, 5), changed);
  coverage.extend("range:m9", "b8", "b4", messages(4, 6, 7));
  assertEquals(coverage.known("m5"), false);
  assertEquals(coverage.known("m3"), true);
  assertEquals(coverage.current("m4"), true);
  assertEquals(coverage.extend("range:m9", "b4", null, []), {
    joined: false,
    deleted: ["m1", "m2", "m3"],
  });
  assertEquals(coverage.current("m4"), true);
  assertEquals(coverage.current("m8"), true);
  assertEquals(coverage.next, null);
});

Deno.test("exhausting a disjoint bridge deletes the stale range without joining", () => {
  const coverage = createAcquiredRange();
  coverage.head(page(null, 1, 2), [], changed);
  coverage.head(page("b8", 8, 9), messages(1, 2), changed);
  assertEquals(coverage.extend("range:m9", "b8", null, messages(6, 7)), {
    joined: false,
    deleted: ["m1", "m2"],
  });
  assertEquals(coverage.gaps(), []);
  assertEquals(coverage.ranges(), [
    { key: "range:m9", first: "m6", last: "m9", next: null },
  ]);
});

Deno.test("crossing a range's newest position without identity proof does not join", () => {
  const coverage = createAcquiredRange();
  coverage.head(page("b1", 1, 3), [], changed);
  coverage.head(page("b8", 8, 9), messages(1, 3), same);
  assertEquals(coverage.extend("range:m9", "b8", "b2", messages(2, 4)), {
    joined: false,
    deleted: ["m3"],
  });
  assertEquals(coverage.gaps(), [{ key: "gap:m1", newer: "m2", older: "m1" }]);
});

Deno.test("warm parking and cursor retirement stay local to the evicted range", () => {
  const coverage = createAcquiredRange();
  coverage.head(page("b3", 3, 4), [], changed);
  coverage.extend("range:m4", "b3", null, messages(1, 2));
  coverage.head(page("b8", 8, 9), messages(1, 2, 3, 4), same);
  coverage.extend("range:m9", "b8", "b6", messages(6, 7));
  const visited = new Set<string>();
  coverage.visit(new Set(["m1", "m8"]), visited);
  assertEquals([...visited].sort(), ["m1", "m2", "m8", "m9"]);
  assertEquals(
    coverage.evict(
      ["m1", "m2", "m3", "m4", "m6", "m7", "m8", "m9"],
      new Set(["m2", "m7"]),
    ),
    ["m1", "m6"],
  );
  assertEquals(coverage.ranges().map((range) => range.next), ["b8", "b3"]);
  assertEquals(coverage.current("m6"), false);
  assertEquals(coverage.current("m7"), false);
  assertEquals(coverage.current("m8"), true);
  coverage.evict(["m8", "m9"], new Set(["m9"]));
  assertEquals(coverage.ranges().map((range) => range.next), [undefined, "b3"]);
});
