// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals } from "@std/assert";
import { TurnTimingAccumulator } from "../turn-timing.ts";

Deno.test("segments use the timing owner's busy union minus waits, independently of the turn", () => {
  const first = [{ start: 0, end: 400 }, { start: 200, end: 700 }];
  const second = [
    { start: 1000, end: 2200 },
    { start: 1200, end: 1500, waitsForUser: true },
  ];
  assertEquals(TurnTimingAccumulator.segment(first), 700);
  assertEquals(TurnTimingAccumulator.segment(second), 900);
  const owner = new TurnTimingAccumulator();
  owner.add({
    start: 0,
    end: 2200,
    terminal: true,
    source: "fixture",
    busy: [...first, second[0]],
    waits: [second[1]],
  });
  assertEquals(owner.result(), {
    state: "known",
    start: 0,
    end: 2200,
    workingMs: 1600,
  });
});
Deno.test("unproven segment evidence never borrows a turn duration or guesses an endpoint", () => {
  assertEquals(TurnTimingAccumulator.segment([]), undefined);
  assertEquals(TurnTimingAccumulator.segment([{}]), undefined);
  assertEquals(TurnTimingAccumulator.segment([{ start: 1 }]), undefined);
  assertEquals(
    TurnTimingAccumulator.segment([
      { start: 1, end: 3 },
      { start: 4 },
    ]),
    undefined,
  );
  assertEquals(
    TurnTimingAccumulator.segment([{ start: 5, end: 4 }]),
    undefined,
  );
  assertEquals(TurnTimingAccumulator.segment([{ start: 0, end: 0 }]), 0);
  assertEquals(
    TurnTimingAccumulator.segment([
      { start: 1, end: 9, waitsForUser: true },
    ]),
    0,
  );
});
