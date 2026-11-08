// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals } from "@std/assert";
import {
  duration,
  exactCount,
  humanDuration,
  relativeTime,
  requestIdle,
} from "../format.ts";
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
Deno.test("human status durations share nonnegative second, minute, hour and day boundaries", () => {
  for (
    const [ms, expected] of [
      [-1, "0 s"],
      [0, "0 s"],
      [999, "0 s"],
      [1000, "1 s"],
      [18_000, "18 s"],
      [59_999, "59 s"],
      [60_000, "1 min"],
      [180_000, "3 min"],
      [3599_999, "59 min"],
      [3600_000, "1 hour"],
      [7200_000, "2 hours"],
      [86399_999, "23 hours"],
      [86400_000, "1 day"],
      [2 * 86400_000, "2 days"],
      [1036862_000, "12 days"],
    ] as const
  ) {
    assertEquals(humanDuration(ms), expected);
    assertEquals(requestIdle(1, ms + 1).label, `Session idle ${expected}`);
  }
});
Deno.test("request idle age stays unknown without a valid session activity clock", () => {
  const now = 1794172800_000;
  for (const time of [undefined, 0, -1, NaN, Infinity, -Infinity]) {
    assertEquals(requestIdle(time, now), {});
  }
  for (const clock of [NaN, Infinity, -Infinity]) {
    assertEquals(requestIdle(1, clock), {});
  }
  assertEquals(requestIdle(now + 1, now), { label: "Session idle 0 s" });
});
