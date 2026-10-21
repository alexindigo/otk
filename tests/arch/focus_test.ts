// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals } from "@std/assert";

const controls =
  ':where(button, input, textarea, select, a[href], summary, [contenteditable="true"], [role="button"], [role="tab"], [role="separator"], [data-otk-focus="content"]):focus-visible:not([tabindex="-1"])';
const compact = (text: string) => text.replace(/\s+/g, "");

/** An allowlist prevents even browser-focusable, unlabelled scroll wrappers
 * from inheriting interactive paint. Merely adding tabindex is never enough. */
function focusErrors(css: string): string[] {
  const errors: string[] = [];
  let rings = 0;
  const source = css.replace(/\/\*[\s\S]*?\*\//g, "");
  for (const rule of source.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if (
      !/outline:\s*2px solid/.test(rule[2]) ||
      !rule[1].includes(":focus-visible")
    ) continue;
    rings++;
    if (compact(rule[1]) !== compact(controls)) {
      errors.push("layout wrapper can acquire the interactive ring");
    }
  }
  if (rings !== 1) errors.push("one shared interactive focus policy required");
  if (!/:focus-visible\s*\{\s*outline:\s*none;/.test(source)) {
    errors.push("layout focus must suppress the native outline");
  }
  return errors;
}

Deno.test("shared focus paint excludes programmatic landmarks, docks, scroll regions and overlay wrappers", async () => {
  const css = await Deno.readTextFile(
    new URL("../../packages/ui/theme.css", import.meta.url),
  );
  assertEquals(focusErrors(css), []);
  for (
    const invalid of [
      css + ":focus-visible { outline: 2px solid var(--control-focus); }",
      css.replace(":where(button,", ":where(div, button,"),
      css.replace(':not([tabindex="-1"])', ""),
      css.replace('[data-otk-focus="content"]', '[tabindex="0"]'),
      css.replace("outline: none;", "outline: auto;"),
    ]
  ) assert(focusErrors(invalid).length > 0);
  for (const name of ["QuestionDock", "PermissionDock"]) {
    const source = await Deno.readTextFile(
      new URL(`../../packages/ui/components/${name}.tsx`, import.meta.url),
    );
    assert(
      /<section\s[^>]*tabindex="-1"/.test(source),
      `${name} is not an interactive Tab stop`,
    );
    assert(
      !source.includes("card.focus()"),
      `${name} must focus its visible controls`,
    );
    if (name === "QuestionDock") {
      assert(
        !source.includes("querySelector"),
        "Question focus uses owned control references, never child component DOM",
      );
    }
  }
});
