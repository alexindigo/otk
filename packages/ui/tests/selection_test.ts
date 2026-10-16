// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertMatch } from "@std/assert";

Deno.test("selection has one shared pointer/underline owner for selected, current and pressed semantics", async () => {
  const css = await Deno.readTextFile(new URL("../theme.css", import.meta.url));
  assert(
    css.includes("--pill-inset: 14px"),
    "Prototype action spacing belongs to the shared control contract",
  );
  for (
    const state of [
      "[aria-selected=true]",
      "[aria-current]:not([aria-current=false])",
      "[aria-pressed=true]",
      "[data-selected]",
    ]
  ) {
    assert(css.includes(state));
  }
  assertMatch(
    css,
    /\[data-otk-selection=vertical\]::after\s*\{[^}]*inset-block: 0;[^}]*margin-block: auto;[^}]*width: 3px;[^}]*height: 14px;/,
  );
  assertMatch(
    css,
    /\[data-otk-selection=horizontal\]::after\s*\{[^}]*bottom: 0;[^}]*height: 2px;/,
  );
  assertMatch(
    css,
    /\[data-otk-selection\]:is\([^}]+background: var\(--otk-selected\);[^}]*box-shadow: var\(--otk-selected-shadow\);/,
  );
  assert(
    !/\[data-otk-reduced-colors\][^{]*\[data-otk-selection/.test(css),
    "Non-colour indicators cannot disappear in reduced colours",
  );
});
