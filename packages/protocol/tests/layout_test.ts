// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals } from "@std/assert";
import { DEFAULT_PREFS, isPreference } from "../preferences.ts";
Deno.test("shell layout preference validates persisted bounds and complete collapsed state", () => {
  const base = DEFAULT_PREFS.shellLayout;
  assertEquals(base, {
    leftWidth: 248,
    leftCollapsed: false,
    rightCollapsed: true,
    rightWidth: 320,
    rightView: "",
  });
  for (const leftWidth of [200, 248, 360]) {
    assertEquals(isPreference("shellLayout", { ...base, leftWidth }), true);
  }
  for (const discoveredCollapsed of [false, true]) {
    assertEquals(
      isPreference("shellLayout", { ...base, discoveredCollapsed }),
      true,
    );
  }
  for (const rightWidth of [280, 320, 480]) {
    assertEquals(
      isPreference("shellLayout", {
        ...base,
        rightWidth,
        rightView: "external-view",
      }),
      true,
    );
  }
  // Normal upgrades retain a valid pre-panel layout without losing left settings.
  assertEquals(
    isPreference("shellLayout", {
      leftWidth: 300,
      leftCollapsed: true,
      rightCollapsed: false,
    }),
    true,
  );
  for (
    const value of [
      { ...base, leftWidth: 199 },
      { ...base, leftWidth: 361 },
      { ...base, leftCollapsed: "true" },
      { ...base, discoveredCollapsed: "true" },
      { leftWidth: 248, leftCollapsed: false },
      { ...base, unknown: true },
      { ...base, rightWidth: 279 },
      { ...base, rightWidth: 481 },
      { ...base, rightWidth: NaN },
      { ...base, rightView: 1 },
      { ...base, rightView: "x".repeat(129) },
    ]
  ) assertEquals(isPreference("shellLayout", value), false);
});
