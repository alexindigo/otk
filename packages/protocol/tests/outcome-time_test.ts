// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals } from "@std/assert";
import { outcomeTime } from "../outcome-time.ts";

Deno.test("terminal clock preference is completed, error, then latest native part", () => {
  assertEquals(outcomeTime({ completed: 10, error: 20, parts: [30] }), {
    state: "known",
    at: 10,
    source: "completed",
  });
  assertEquals(outcomeTime({ error: 20, parts: [30] }), {
    state: "known",
    at: 20,
    source: "error",
  });
  assertEquals(outcomeTime({ parts: [10, undefined, 30, 20] }), {
    state: "known",
    at: 30,
    source: "part",
  });
  assertEquals(outcomeTime({ completed: 0 }), {
    state: "known",
    at: 0,
    source: "completed",
  });
});
Deno.test("no observation clock or message creation clock substitutes for a terminal time", () => {
  assertEquals(outcomeTime({ completed: NaN, parts: [Infinity, -1] }), {
    state: "unknown",
    reason: "No native completion, error or part timestamp was recorded.",
  });
});
