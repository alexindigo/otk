// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals, assertThrows } from "@std/assert";
import {
  DEFAULT_PREFS,
  isPreference,
  PreferenceRegistry,
  preferences,
  preferenceToggleValue,
} from "../mod.ts";

Deno.test("toggle presentation preserves legacy values while checked consistently means expanded", () => {
  for (
    const [key, on, off] of [["collapseFileChanges", false, true], [
      "thinking",
      "show",
      "hide",
    ]] as const
  ) {
    const definition = preferences.list().find((row) => row.key === key)!;
    for (const surface of [definition.settings!, definition.display!]) {
      assertEquals(surface.control.kind, "toggle");
      assertEquals(preferenceToggleValue(surface.control, true), on);
      assertEquals(preferenceToggleValue(surface.control, false), off);
      assert(Object.isFrozen(surface.control));
      assert(preferences.validate(key, on));
      assert(preferences.validate(key, off));
    }
  }
  assertEquals(preferenceToggleValue({ kind: "toggle" }, true), true);
  assertEquals(preferenceToggleValue({ kind: "toggle" }, false), false);
});
Deno.test("toggle mappings must describe two valid stored states including the default", () => {
  for (
    const control of [
      { kind: "toggle" as const },
      { kind: "toggle" as const, onValue: "show", offValue: "show" },
      { kind: "toggle" as const, onValue: "show", offValue: "invalid" },
    ]
  ) {
    assertThrows(() =>
      new PreferenceRegistry().register({
        key: "thinking",
        default: "hide",
        label: "Thinking",
        validate: (v): v is "show" | "hide" => v === "show" || v === "hide",
        display: { order: 1, control },
      })
    );
  }
});

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
Deno.test("theme preference checks identity shape without closing installed choices and preserves Dark default", () => {
  for (
    const id of [
      "otk-dark",
      "otk-light",
      "system",
      "dark",
      "light",
      "custom",
      "plugin:theme.v2",
    ]
  ) {
    assert(isPreference("theme", id));
  }
  for (
    const id of [
      "",
      "bad theme",
      "../theme",
      "a".repeat(121),
      null,
      true,
      {},
      [],
    ]
  ) {
    assertEquals(isPreference("theme", id), false);
  }
  assertEquals(DEFAULT_PREFS.theme, "otk-dark");
});
Deno.test("System light preference belongs to the theme feature and keeps open identities with Linen default", () => {
  assertEquals(DEFAULT_PREFS.systemLightTheme, "otk-light");
  for (const id of ["otk-light", "otk-light-stone", "plugin:light.v2"]) {
    assert(isPreference("systemLightTheme", id));
  }
  for (const value of ["", "invalid theme", null, true, {}]) {
    assertEquals(isPreference("systemLightTheme", value), false);
  }
});
Deno.test("notification channel prefs preserve host defaults and reject coercion and extra channels", () => {
  assertEquals([
    DEFAULT_PREFS["notify.toast"],
    DEFAULT_PREFS["notify.os"],
    DEFAULT_PREFS["notify.sound"],
    DEFAULT_PREFS["notify.badge"],
  ], [true, false, false, true]);
  for (
    const key of ["notify.toast", "notify.os", "notify.sound", "notify.badge"]
  ) {
    assert(isPreference(key, true));
    assert(isPreference(key, false));
    for (const value of ["true", 1, null, {}, []]) {
      assertEquals(isPreference(key, value), false);
    }
  }
  assertEquals(isPreference("notify.push", true), false);
});
