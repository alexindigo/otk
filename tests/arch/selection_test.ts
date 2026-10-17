// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals } from "@std/assert";

function stateErrors(source: string): string[] {
  return /\b(?:aria-selected|aria-current|aria-pressed|data-selected)\s*=|["'`](?:aria-selected|aria-current|aria-pressed|data-selected|is-selected|otk-selected)["'`]|class(?:Name)?\s*=\s*["'][^"']*\bis-selected\b/
      .test(source)
    ? ["selection state belongs to the shared binding"]
    : [];
}
function paintErrors(css: string): string[] {
  const errors: string[] = [];
  for (const [, selector, body] of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if (/\[aria-(?:selected|current|pressed)|\[data-selected/.test(selector)) {
      errors.push("selection paint must use the state class");
    }
    if (/otk-selection|is-selected/.test(selector)) {
      if (/\[aria-|\[data-selected/.test(selector)) {
        errors.push("selection has no attribute-driven decoration");
      }
      if (
        /\bposition\s*:|(?:^|;)\s*(?:top|left|right|bottom|inset)(?:-[\w-]+)?\s*:/
          .test(body)
      ) {
        errors.push("selection participates in layout");
      }
    }
  }
  return errors;
}
Deno.test("selection state and decoration have one enforceable owner across UI consumers", async () => {
  async function inspect(directory: URL): Promise<void> {
    for await (const entry of Deno.readDir(directory)) {
      const file = new URL(
        entry.name + (entry.isDirectory ? "/" : ""),
        directory,
      );
      if (entry.isDirectory && entry.name !== "tests") await inspect(file);
      else if (
        /\.tsx?$/.test(entry.name) &&
        file.href !==
          new URL("../../packages/ui/components/selection.ts", import.meta.url)
            .href
      ) {
        const source = await Deno.readTextFile(file);
        assertEquals(
          stateErrors(source),
          [],
          file.pathname,
        );
        for (const [item] of source.matchAll(/<button\b[\s\S]*?<\/button>/g)) {
          if (/data-otk-selection="(?:vertical|horizontal)"/.test(item)) {
            assert(
              item.includes("<SelectionContent"),
              `${file.pathname}: items must group content beside their flowing mark`,
            );
          }
        }
      } else if (entry.name.endsWith(".css")) {
        assertEquals(
          paintErrors(await Deno.readTextFile(file)),
          [],
          file.pathname,
        );
      }
    }
  }
  await inspect(new URL("../../packages/ui/", import.meta.url));
  const theme = await Deno.readTextFile(
    new URL("../../packages/ui/theme.css", import.meta.url),
  );
  for (
    const [orientation, pseudo] of [["vertical", "before"], [
      "horizontal",
      "after",
    ]]
  ) {
    assert(
      new RegExp(
        `\\[data-otk-selection=${orientation}\\]\\.otk-selection-item::${pseudo}\\s*\\{[^}]*content: "";`,
      ).test(theme),
      `${orientation}: the shared owner must always reserve its in-flow pseudo-element`,
    );
  }
  for (
    const invalid of [
      "<button aria-selected={chosen}>",
      '<a aria-current="page">',
      "<button aria-pressed={chosen}>",
      "<button data-selected={chosen}>",
      '<button class="is-selected">',
      '<button class={["row", {"is-selected": chosen}]}>',
      '<button class={["row", {"otk-selected": chosen}]}>',
      'element.setAttribute("aria-selected", "true")',
      'element.classList.toggle("is-selected", chosen)',
      'const props = {"aria-current": "page"}',
    ]
  ) assert(stateErrors(invalid).length > 0, invalid);
  assertEquals(
    stateErrors('<button {...selection({selected, kind: "current"})}>'),
    [],
  );
  for (
    const invalid of [
      "[aria-selected=true] { background: red; }",
      "[data-selected] { color: red; }",
      '.is-selected::after { position: absolute; content: ""; }',
      "[data-otk-selection] { position: relative; }",
      ".otk-selection-marker { inset-block: 0; }",
    ]
  ) assert(paintErrors(invalid).length > 0, invalid);
  assertEquals(
    paintErrors(".is-selected { background: var(--otk-selected); }"),
    [],
  );
  assertEquals(
    paintErrors(
      '[data-otk-selection=horizontal]::after { content: ""; height: 2px; }',
    ),
    [],
  );
});
