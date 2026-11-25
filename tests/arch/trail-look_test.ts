// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals } from "@std/assert";
import { Source, uiSources } from "./analysis.ts";
import { rules, selectorAlternatives, words } from "./styles.ts";

const owner = "packages/ui/components/TaskTrail";
const selectionMark = /otk-tab|otk-selection|is-selected/;
const crumb = /\.otk-(?:session-crumb\b|crumb-title\b|trail[-\b])|\[data-crumb/;

function markupErrors(source: string): string[] {
  const parsed = new Source(source);
  const errors = new Set<string>();
  let usesLocation = false;
  for (const node of parsed.all) {
    if (node.type === "CallExpression") {
      const name = parsed.name(node.callee);
      if (name === "location") usesLocation = true;
      if (name === "selection") errors.add("selection binding");
    }
    if (
      node.type === "JSXOpeningElement" &&
      ["SelectionContent", "ControlIcon"].includes(parsed.name(node.name) ?? "")
    ) errors.add("selection content");
    const text = parsed.string(node);
    if (text === "data-otk-selection") errors.add("selection attribute");
    else if (text && selectionMark.test(text)) errors.add("selection class");
    if (
      node.type === "JSXAttribute" &&
      parsed.name(node.name) === "data-otk-selection"
    ) errors.add("selection attribute");
  }
  if (!usesLocation) errors.add("missing location binding");
  return [...errors];
}

function paintErrors(path: string, css: string): string[] {
  const errors = new Set<string>();
  for (const { selector, declarations } of rules(css)) {
    if (path !== `${owner}.css`) {
      if (crumb.test(selector)) errors.add("trail paint outside TaskTrail");
      continue;
    }
    if (selectionMark.test(selector)) errors.add("selection selector");
    if (/::?(?:before|after)\b/.test(selector)) errors.add("pseudo-element");
    for (const [property, value] of declarations) {
      if (
        /^(?:background|box-shadow)(?:-|$)/.test(property) ||
        /^border(?:$|-(?!.*radius))/.test(property)
      ) {
        errors.add("crumb decoration");
      }
      if (
        /^text-decoration(?:-line)?$/.test(property) &&
        words(value).includes("underline") &&
        selectorAlternatives(selector).some((part) =>
          !/:hover\b|:focus-visible\b/.test(part)
        )
      ) errors.add("underline at rest");
    }
  }
  return [...errors];
}

Deno.test("breadcrumb markup and paint are separate from collection selection", async () => {
  for (
    const [source, error] of [
      ["selection({ selected: true });", "selection binding"],
      ['<span data-otk-selection="horizontal" />', "selection attribute"],
      ["<SelectionContent />", "selection content"],
      ["<ControlIcon />", "selection content"],
      ['<a class="otk-tab-open is-selected" />', "selection class"],
    ]
  ) {
    assertEquals(markupErrors(`location({ current: true }); ${source}`), [
      error,
    ]);
  }
  assertEquals(markupErrors("<span />"), ["missing location binding"]);
  assertEquals(markupErrors("<span {...location({ current })} />"), []);
  for (
    const [css, error] of [
      [".otk-session-crumb { background: red }", "crumb decoration"],
      [
        ".otk-session-crumb:hover { box-shadow: 0 1px red }",
        "crumb decoration",
      ],
      [
        ".otk-session-crumb { border-block-end: 1px solid }",
        "crumb decoration",
      ],
      ['.otk-session-crumb::after { content: "" }', "pseudo-element"],
      [
        ".otk-session-crumb:not(.is-selected) { color: red }",
        "selection selector",
      ],
      [
        ".otk-session-crumb { text-decoration-line: underline }",
        "underline at rest",
      ],
    ]
  ) assertEquals(paintErrors(`${owner}.css`, css), [error]);
  assertEquals(
    paintErrors("ProjectTabs.css", "[data-crumb] { color: red }"),
    ["trail paint outside TaskTrail"],
  );
  assertEquals(
    paintErrors(
      `${owner}.css`,
      ".otk-session-crumb:focus-visible .otk-trail-title { text-decoration: underline }",
    ),
    [],
  );

  const errors: string[] = [];
  for (const [path, source] of await uiSources()) {
    const found = path === `${owner}.tsx`
      ? markupErrors(source)
      : path.endsWith(".css")
      ? paintErrors(path, source)
      : [];
    errors.push(...found.map((error) => `${path}: ${error}`));
  }
  assertEquals(errors, []);
});
