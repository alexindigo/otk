// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals } from "@std/assert";
import { activityTimeRange } from "../components/activity-time.ts";

Deno.test("activity clocks omit missing and indistinguishable endpoints at each display precision", () => {
  assertEquals(activityTimeRange({ first: 100 }, String), "100");
  assertEquals(activityTimeRange({ first: 100, last: 100 }, String), "100");
  assertEquals(
    activityTimeRange({ first: 100, last: 200 }, () => "12:00"),
    "12:00",
  );
  assertEquals(
    activityTimeRange({ first: 100, last: 200 }, String),
    "100 - 200",
  );
});
