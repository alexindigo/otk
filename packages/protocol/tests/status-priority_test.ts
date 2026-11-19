// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals } from "@std/assert";
import {
  type ProjectStatus,
  ROLLUP_PRIORITY,
  rollupStatus,
  URGENCY_PRIORITY,
  urgentStatus,
} from "../inbox.ts";

Deno.test("lamp display and user-attention urgency differ only for working versus finished", () => {
  assertEquals(ROLLUP_PRIORITY, ["blocked", "working", "finished", "none"]);
  assertEquals(URGENCY_PRIORITY, ["blocked", "finished", "working", "none"]);
  for (const a of ROLLUP_PRIORITY) {
    for (const b of ROLLUP_PRIORITY) {
      const states: ProjectStatus[] = [a, b];
      assertEquals(
        rollupStatus(a, b),
        ROLLUP_PRIORITY.find((state) => states.includes(state)),
      );
      assertEquals(
        urgentStatus(a, b),
        URGENCY_PRIORITY.find((state) => states.includes(state)),
      );
    }
  }
  assertEquals(rollupStatus("finished", "working"), "working");
  assertEquals(urgentStatus("finished", "working"), "finished");
  assertEquals(rollupStatus(undefined), "none");
  assertEquals(urgentStatus(undefined), "none");
});
