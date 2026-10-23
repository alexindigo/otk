// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals } from "@std/assert";
import { Source, uiSources } from "./analysis.ts";
import { rules } from "./styles.ts";
import { nodes, property } from "./syntax.ts";

function stateErrors(source: string): string[] {
  let parsed: Source;
  try {
    parsed = new Source(source);
  } catch {
    return ["selection source must parse"];
  }
  const attributes = new Set([
    "aria-selected",
    "aria-current",
    "aria-pressed",
    "data-selected",
  ]);
  const classes = new Set(["is-selected", "is-highlighted", "otk-selected"]);
  for (const node of parsed.all) {
    if (
      (node.type === "JSXAttribute" || node.type === "ObjectProperty") &&
      attributes.has(
        property(node.type === "JSXAttribute" ? node.name : node.key) ?? "",
      )
    ) return ["selection state belongs to the shared binding"];
    if (
      node.type === "JSXAttribute" &&
      ["class", "className"].includes(property(node.name) ?? "") &&
      [...nodes(node)].some((child) =>
        parsed.string(child)?.split(/\s+/).some((name) => classes.has(name))
      )
    ) return ["selection state belongs to the shared binding"];
    if (
      node.type === "CallExpression" &&
      /(?:\.classList\.(?:toggle|add|remove)|\.setAttribute)$/.test(
        parsed.name(node.callee) ?? "",
      ) &&
      [...attributes, ...classes].includes(
        parsed.string(node.arguments[0]) ?? "",
      )
    ) return ["selection state belongs to the shared binding"];
  }
  return [];
}
function paintErrors(css: string): string[] {
  const errors: string[] = [];
  for (const { selector, declarations } of rules(css)) {
    if (/\[aria-(?:selected|current|pressed)|\[data-selected/.test(selector)) {
      errors.push("selection paint must use the state class");
    }
    if (/otk-selection|is-selected/.test(selector)) {
      if (/\[aria-|\[data-selected/.test(selector)) {
        errors.push("selection has no attribute-driven decoration");
      }
      if (
        [...declarations.keys()].some((prop) =>
          /^(?:position|top|left|right|bottom|inset)(?:-|$)/.test(prop)
        )
      ) {
        errors.push("selection participates in layout");
      }
    }
  }
  return errors;
}
Deno.test("selection state and decoration have one enforceable owner across UI consumers", async () => {
  for (const [path, source] of await uiSources()) {
    if (path.endsWith(".css")) assertEquals(paintErrors(source), [], path);
    else if (path !== "packages/ui/components/selection.ts") {
      assertEquals(stateErrors(source), [], path);
      const parsed = new Source(source, path);
      for (const node of parsed.all) {
        if (
          node.type === "JSXElement" &&
          parsed.name(node.openingElement.name) === "button" &&
          parsed.attr(node.openingElement, "data-otk-selection")
        ) {
          assert(
            [...nodes(node)].some((child) =>
              child.type === "JSXOpeningElement" &&
              parsed.name(child.name) === "SelectionContent"
            ),
            `${path}: items must group content beside their flowing mark`,
          );
        }
      }
    }
  }
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
      '<button class="is-highlighted">',
      '<button class={["row", {"is-selected": chosen}]}>',
      '<button class={["row", {"otk-selected": chosen}]}>',
      'element.setAttribute("aria-selected", "true")',
      'element.classList.toggle("is-selected", chosen)',
      'const props = {"aria-current": "page"}',
    ]
  ) assert(stateErrors(invalid).length > 0, invalid);
  assertEquals(
    stateErrors('<button {...selection({selected, kind: "current"})} />'),
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
