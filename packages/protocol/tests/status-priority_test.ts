// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals } from "@std/assert";
import {
  type ProjectStatus,
  ROLLUP_PRIORITY,
  rollupStatus,
  urgentStatus,
} from "../inbox.ts";

Deno.test("D78: aggregate lamps give red precedence over yellow, then green and grey", () => {
  assertEquals<readonly ProjectStatus[]>(ROLLUP_PRIORITY, [
    "blocked",
    "finished",
    "working",
    "dependencies",
    "none",
  ]);
  for (const a of ROLLUP_PRIORITY) {
    for (const b of ROLLUP_PRIORITY) {
      const states: ProjectStatus[] = [a, b];
      assertEquals(
        rollupStatus(a, b),
        ROLLUP_PRIORITY.find((state) => states.includes(state)),
      );
      assertEquals(
        urgentStatus(a, b),
        ROLLUP_PRIORITY.find((state) => states.includes(state)),
      );
    }
  }
  assertEquals(rollupStatus("working", "finished"), "finished");
  for (const state of ROLLUP_PRIORITY) {
    assertEquals(rollupStatus(state, "blocked"), "blocked");
    assertEquals(rollupStatus("blocked", state), "blocked");
  }
  assertEquals(rollupStatus("working"), "working");
  assertEquals(rollupStatus(), "none");
  assertEquals(urgentStatus("finished", "working"), "finished");
  assertEquals(rollupStatus(undefined), "none");
  assertEquals(urgentStatus(undefined), "none");
});
