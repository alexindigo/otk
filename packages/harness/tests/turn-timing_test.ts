// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals } from "@std/assert";
import { TurnTimingAccumulator } from "../turn-timing.ts";

Deno.test("working time unions busy intervals and excludes waits, not call gaps", () => {
  const timing = new TurnTimingAccumulator();
  timing.add({
    start: 1000,
    end: 1500,
    terminal: true,
    source: "fixture/model",
    busy: [{ start: 1000, end: 1500 }],
    waits: [],
  });
  const later = 1000 + 10 * 86400000;
  timing.add({
    start: later,
    end: later + 500,
    terminal: true,
    source: "fixture/tool",
    busy: [{ start: later, end: later + 500 }],
    waits: [],
  });
  assertEquals(timing.result(), {
    state: "known",
    start: 1000,
    end: later + 500,
    workingMs: 1000,
  });
});
Deno.test("overlapping model and tools are counted once; wait overlap is subtracted once", () => {
  const timing = new TurnTimingAccumulator();
  timing.add({
    start: 0,
    end: 1000,
    terminal: true,
    source: "fixture",
    busy: [{ start: 0, end: 700 }, { start: 500, end: 1000 }],
    waits: [{ start: 200, end: 400 }, { start: 300, end: 600 }],
  });
  assertEquals(timing.result(), {
    state: "known",
    start: 0,
    end: 1000,
    workingMs: 600,
  });
});
Deno.test("interrupted terminal without an end is unknown, never active", () => {
  const timing = new TurnTimingAccumulator();
  timing.add({
    start: 0,
    terminal: true,
    source: "fixture",
    busy: [],
    waits: [],
    unknown: "missing-end",
  });
  assertEquals(timing.result(), {
    state: "unknown",
    start: 0,
    terminal: true,
    reason: "missing-end",
  });
});
Deno.test("migration loss wins over recorded partial tool intervals without guessing an end", () => {
  const timing = new TurnTimingAccumulator();
  timing.add({
    start: 0,
    terminal: true,
    source: "fixture/migration",
    busy: [{ start: 10, end: 100 }],
    waits: [],
    unknown: "migration",
  });
  assertEquals(timing.result(), {
    state: "unknown",
    start: 0,
    terminal: true,
    reason: "migration",
  });
});
Deno.test("an active call counts only recorded busy intervals, never observation or next-prompt time", () => {
  const timing = new TurnTimingAccumulator();
  timing.add({
    start: 0,
    terminal: false,
    source: "fixture",
    busy: [{ start: 0, end: 500 }],
    waits: [],
  });
  assertEquals(timing.result(), { state: "active", start: 0, workingMs: 500 });
});
