// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals } from "@std/assert";
import { terminalEvidence } from "../metadata.ts";

Deno.test("V2 terminal clocks require a qualified outcome or a completed shell", () => {
  assertEquals(terminalEvidence(100, "unknown"), undefined);
  assertEquals(terminalEvidence(NaN, "failed"), undefined);
  assertEquals(terminalEvidence(100, "failed", 200), 200);
  assertEquals(terminalEvidence(100, "succeeded"), 100);
});
