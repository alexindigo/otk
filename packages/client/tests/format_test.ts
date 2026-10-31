// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals } from "@std/assert";
import { duration, exactCount, relativeTime } from "../format.ts";
import { visitTime } from "../inbox.ts";

Deno.test("shared duration and exact count retain zero, precision and nonnegative elapsed time", () => {
  assertEquals([duration(-1), duration(0), duration(1234)], [
    "0.0s",
    "0.0s",
    "1.2s",
  ]);
  assertEquals(exactCount(1234567), "1,234,567");
  assertEquals(exactCount(0), "0");
});
Deno.test("relative clocks share inbox day and remaining-hour semantics", () => {
  for (
    const [ms, expected] of [[-1, "now"], [60_000, "1m"], [3_600_000, "1h"], [
      90_000_000,
      "1d 1h",
    ]] as const
  ) {
    assertEquals(relativeTime(0, ms), expected);
    assertEquals(visitTime(0, ms), expected);
  }
});
