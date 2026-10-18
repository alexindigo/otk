// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals, assertMatch } from "@std/assert";
import { selection } from "../components/selection.ts";

Deno.test("selection has one shared pointer/underline owner for selected, current and pressed semantics", async () => {
  const css = await Deno.readTextFile(new URL("../theme.css", import.meta.url));
  assert(
    css.includes("--item-inset: 12px") &&
      css.includes("--pill-inset: var(--item-inset)"),
    "Items and action pills share the accepted item inset token",
  );
  assert(
    css.includes("var(--selection-inset, var(--item-inset))") &&
      css.includes("var(--selection-padding, 4px var(--item-inset))"),
    "Both selection orientations consume the shared item inset",
  );
  for (const selected of [false, true]) {
    for (
      const kind of ["selected", "current", "pressed", "candidate"] as const
    ) {
      const bound = selection({ kind, selected, class: "row" });
      assertEquals(bound.class.split(" ").includes("is-selected"), selected);
      assert(bound.class.includes("row"));
      assertEquals(
        bound["aria-selected"],
        kind === "selected" ? String(selected) : undefined,
      );
      assertEquals(
        bound["aria-current"],
        kind === "current" && selected ? "page" : undefined,
      );
      assertEquals(
        bound["aria-pressed"],
        kind === "pressed" ? String(selected) : undefined,
      );
    }
  }
  const candidate = selection({
    kind: "pressed",
    selected: false,
    candidate: true,
  });
  assert(candidate.class.includes("is-selected"));
  assertEquals(
    candidate["aria-pressed"],
    "false",
    "Moving the candidate never commits an answer",
  );
  const highlighted = selection({
    kind: "selected",
    selected: false,
    highlighted: true,
  });
  assert(highlighted.class.includes("is-highlighted"));
  assert(!highlighted.class.includes("is-selected"));
  assertEquals(highlighted["aria-selected"], "false");
  assertMatch(
    css,
    /\[data-otk-selection=vertical\]\.otk-selection-item::before\s*\{[^}]*content: "";[^}]*width: 3px;[^}]*height: 14px;[^}]*margin-inline-start: var\(--selection-pointer-inset\);/,
  );
  assertMatch(
    css,
    /\[data-otk-selection=horizontal\]\.otk-selection-item::after\s*\{[^}]*content: "";[^}]*height: 2px;[^}]*margin-inline: 8px;/,
  );
  assertMatch(
    css,
    /\[data-otk-selection\]\.is-selected\s*\{[^}]*background: var\(--otk-selected\);[^}]*box-shadow: var\(--otk-selected-shadow\);/,
  );
  assert(
    !/\[data-otk-reduced-colors\][^{]*\[data-otk-selection/.test(css),
    "Non-colour indicators cannot disappear in reduced colours",
  );
});
