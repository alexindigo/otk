// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals } from "@std/assert";
import { DEFAULT_PREFS, isPreference } from "../mod.ts";

Deno.test("prefs validates the entire whitelist without coercion or inherited keys", () => {
  for (const [key, value] of Object.entries(DEFAULT_PREFS)) {
    assert(isPreference(key, value));
  }
  for (
    const [key, value] of [
      ["constructor", true],
      ["unknown", true],
      ["timestamps", "true"],
      ["thinking", true],
      ["diffStyle", { toString: () => "auto" }],
      ["diffStyle", "stacked"],
    ]
  ) {
    assertEquals(isPreference(key, value), false);
  }
});
Deno.test("keymap prefs retain extensible string overrides and reject malformed or oversized records", () => {
  assert(
    isPreference("keymap", { "palette.open": "Ctrl+j", "future.command": "" }),
  );
  for (
    const value of [
      null,
      [],
      true,
      { "palette.open": true },
      { "bad id": "Ctrl+j" },
      { "palette.open": "x".repeat(101) },
      Object.fromEntries(
        Array.from({ length: 101 }, (_, i) => [`binding.${i}`, "x"]),
      ),
    ]
  ) {
    assertEquals(isPreference("keymap", value), false);
  }
  assertEquals(DEFAULT_PREFS.thinking, "hide");
  assertEquals(DEFAULT_PREFS.pasteSummary, true);
});
Deno.test("theme preference allows only shipped choices and preserves the existing Dark default", () => {
  for (const id of ["otk-dark", "otk-light", "system"]) {
    assert(isPreference("theme", id));
  }
  for (const id of ["dark", "light", "custom", null, true, {}, []]) {
    assertEquals(isPreference("theme", id), false);
  }
  assertEquals(DEFAULT_PREFS.theme, "otk-dark");
});
