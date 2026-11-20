// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals } from "@std/assert";
import { DEFAULT_PREFS, isPreference, preferences } from "../mod.ts";
import { TEXT_SIZES } from "../preferences/visual.ts";

Deno.test("text size has five validated authoritative settings choices", () => {
  assertEquals(DEFAULT_PREFS.textSize, "100");
  assert(Object.isFrozen(TEXT_SIZES));
  const row = preferences.settings("appearance").find((row) =>
    row.key === "textSize"
  )!;
  assertEquals(row.label, "Text size");
  assertEquals(row.settings!.control.kind, "segmented");
  assert(row.settings!.control.kind !== "toggle");
  assertEquals(
    row.settings!.control.options.map((option) => option.value),
    [...TEXT_SIZES],
  );
  assert(Object.isFrozen(row.settings!.control.options));
  for (const value of TEXT_SIZES) assert(isPreference("textSize", value));
  for (
    const value of [90, 100, 1.5, "1.5", "200", "100%", null, true, {}, []]
  ) {
    assertEquals(isPreference("textSize", value), false);
  }
});
