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
