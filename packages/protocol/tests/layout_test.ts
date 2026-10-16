// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals } from "@std/assert";
import { DEFAULT_PREFS, isPreference } from "../preferences.ts";
Deno.test("shell layout preference validates persisted bounds and complete collapsed state", () => {
  const base = DEFAULT_PREFS.shellLayout;
  assertEquals(base, {
    leftWidth: 248,
    leftCollapsed: false,
    rightCollapsed: true,
  });
  for (const leftWidth of [200, 248, 360]) {
    assertEquals(isPreference("shellLayout", { ...base, leftWidth }), true);
  }
  for (
    const value of [
      { ...base, leftWidth: 199 },
      { ...base, leftWidth: 361 },
      { ...base, leftCollapsed: "true" },
      { leftWidth: 248, leftCollapsed: false },
      { ...base, unknown: true },
    ]
  ) assertEquals(isPreference("shellLayout", value), false);
});
