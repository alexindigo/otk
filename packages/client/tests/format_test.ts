// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals } from "@std/assert";
import {
  age,
  elapsed,
  exactCount,
  metaList,
  metaParts,
  remaining,
  requestIdle,
} from "../format.ts";

Deno.test("shared duration and exact count retain zero, precision and nonnegative elapsed time", () => {
  assertEquals([-1, 0, 1234].map((ms) => elapsed(ms).text), [
    "0s",
    "0s",
    "1.2s",
  ]);
  for (const ms of [-1, 0]) {
    assertEquals(elapsed(ms).parts, [{ value: "0", unit: "s" }]);
  }
  assertEquals(elapsed(1234).parts, [{ value: "1.2", unit: "s" }]);
  assertEquals(exactCount(1234567), "1,234,567");
  assertEquals(exactCount(0), "0");
});
Deno.test("relative clocks share inbox day and remaining-hour semantics", () => {
  for (
    const [ms, expected, spoken] of [
      [-1, "now", "just now"],
      [60_000, "1m", "1 minute ago"],
      [3_600_000, "1h", "1 hour ago"],
      [
        90_000_000,
        "1d 1h",
        "1 day, 1 hour ago",
      ],
    ] as const
  ) {
    const at = 1234;
    const time = age(at, at + ms);
    assertEquals(time.text, expected);
    assertEquals(time.spoken, spoken);
    assertEquals(time.iso, new Date(at).toISOString());
  }
  assertEquals(
    age(0, 3_600_000, "inactive").spoken,
    "1 hour before it became inactive",
  );
});
Deno.test("work and status durations share nonnegative second, minute, hour and day boundaries", () => {
  for (
    const [ms, expected] of [
      [-1, "0s"],
      [0, "0s"],
      [999, "1s"],
      [1000, "1s"],
      [18_000, "18s"],
      [59_999, "1m"],
      [60_000, "1m"],
      [65_000, "1m 5s"],
      [180_000, "3m"],
      [3599_999, "1h"],
      [3600_000, "1h"],
      [7200_000, "2h"],
      [86399_999, "1d"],
      [86400_000, "1d"],
      [2 * 86400_000, "2d"],
      [1036862_000, "12d 1m 2s"],
    ] as const
  ) {
    assertEquals(elapsed(ms).text, expected);
    const idle = requestIdle(1, ms + 1);
    assertEquals(idle.lead, "Session idle");
    assertEquals(idle.time?.text, expected);
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
  assertEquals(requestIdle(now + 1, now), {
    lead: "Session idle",
    time: elapsed(0),
  });
});

Deno.test("time parts, accessible wording and ISO share the elapsed rounding", () => {
  assertEquals(elapsed(65_000).parts, [{ value: "1", unit: "m" }, {
    value: "5",
    unit: "s",
  }]);
  const days = elapsed(1036862_000);
  assertEquals(days.parts, [{ value: "12", unit: "d" }, {
    value: "1",
    unit: "m",
  }, { value: "2", unit: "s" }]);
  assertEquals(days.iso, "P12DT1M2S");
  const time = elapsed(4_939_100);
  assertEquals(time.text, "1h 22m 19.1s");
  assertEquals(time.spoken, "1 hour, 22 minutes, 19.1 seconds");
  assertEquals(time.iso, "PT1H22M19.1S");
  assertEquals(elapsed(60_000).spoken, "1 minute");
  assertEquals(elapsed(0).spoken, "0 seconds");
  assertEquals(elapsed(0).iso, "PT0S");
});

Deno.test("remaining rounds up to the requested step", () => {
  assertEquals(remaining(4_100, "second").text, "5s");
  assertEquals(remaining(0, "second").text, "1s");
  assertEquals(remaining(61_000, "minute").text, "2m");
  assertEquals(remaining(1, "minute").text, "1m");
});

Deno.test("metadata retains structured time and omits empty entries", () => {
  const time = elapsed(65_000);
  const items = [undefined, "Worked for", false, "", time] as const;
  assertEquals(metaParts(items), ["Worked for", time]);
  assertEquals(metaList(items), "Worked for · 1m 5s");
});
