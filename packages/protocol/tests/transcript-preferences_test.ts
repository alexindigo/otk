// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals } from "@std/assert";
import {
  createPreferences,
  DEFAULT_PREFS,
  PreferenceRegistry,
  registerTranscriptPreferences,
} from "../mod.ts";

Deno.test("transcript scrollbar defaults on in standalone and shipped compositions", () => {
  const registry = new PreferenceRegistry();
  registerTranscriptPreferences(registry);
  assertEquals(registry.defaults().scrollbar, true);
  assertEquals(createPreferences().defaults().scrollbar, true);
  assertEquals(DEFAULT_PREFS.scrollbar, true);
  const control = registry.display().find((item) => item.key === "scrollbar");
  assertEquals(control?.display?.control, { kind: "toggle" });
});

Deno.test("explicit scrollbar preferences keep boolean meaning without coercion", () => {
  const registry = createPreferences();
  assertEquals(registry.validate("scrollbar", false), true);
  assertEquals(registry.validate("scrollbar", true), true);
  for (const value of [undefined, null, 0, 1, "false", "true"]) {
    assertEquals(registry.validate("scrollbar", value), false);
  }
});
