// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals } from "@std/assert";
import { Source, uiSources } from "./analysis.ts";
import { cssTree, rules, selectorAlternatives } from "./styles.ts";
import { nodes, property } from "./syntax.ts";

const controls = [
  "button",
  '[role="button"]',
  '[role="tab"]',
  '[role="menuitem"]',
  "summary",
  ".otk-chip",
  ".otk-pill",
];

function labelOverrides(css: string, classes: Set<string>): string[] {
  return rules(css).filter((rule) => {
    if (!rule.declarations.has("white-space")) return false;
    return selectorAlternatives(rule.selector).some((selector) => {
      const tree = cssTree.parse(selector, { context: "selector" });
      let control = false;
      cssTree.walk(tree, (node) => {
        // Only the subject compound, not an ancestor containing prose/code.
        if (node.type === "Combinator") control = false;
        if (
          node.type === "TypeSelector" &&
          ["button", "summary"].includes(node.name)
        ) control = true;
        if (node.type === "ClassSelector" && classes.has(node.name)) {
          control = true;
        }
        if (
          node.type === "AttributeSelector" && node.name.name === "role" &&
          node.value &&
          ["button", "tab", "menuitem"].includes(
            node.value.type === "String" ? node.value.value : node.value.name,
          )
        ) control = true;
      });
      return control;
    });
  }).map((rule) => rule.selector);
}

Deno.test("button-like controls inherit one shared label and shrink policy", async () => {
  const sources = await uiSources(),
    classes = new Set(["otk-chip", "otk-pill"]);
  for (const [path, text] of sources) {
    if (!path.endsWith(".tsx")) continue;
    const source = new Source(text, path);
    for (const node of source.all) {
      if (node.type !== "JSXOpeningElement") continue;
      if (
        !["button", "summary"].includes(source.name(node.name) ?? "") &&
        !["button", "tab", "menuitem"].includes(
          source.string(source.attr(node, "role")) ?? "",
        )
      ) continue;
      // Include binding-supplied classes (selection/toggle and class arrays),
      // not just a literal class attribute on the native element.
      for (const field of nodes(node)) {
        const value =
          field.type === "JSXAttribute" && property(field.name) === "class"
            ? field.value
            : field.type === "ObjectProperty" && property(field.key) === "class"
            ? field.value
            : undefined;
        if (!value) continue;
        for (const literal of nodes(value)) {
          if (literal.type !== "StringLiteral") continue;
          for (const name of literal.value.split(/\s+/)) {
            if (name) classes.add(name);
          }
        }
      }
    }
  }
  const shared = rules(await Deno.readTextFile("packages/ui/theme.css"));
  const label = shared.find((rule) => rule.selector === ".otk-control-label");
  assert(label, "Text slots need a shared owner even outside a button");
  assertEquals(label.declarations.get("white-space"), "nowrap");
  assertEquals(label.declarations.get("text-overflow"), "ellipsis");
  assertEquals(label.declarations.get("overflow"), "hidden");
  for (const selector of controls) {
    const owner = shared.find((rule) =>
      selectorAlternatives(rule.selector).includes(selector) &&
      rule.declarations.get("white-space") === "nowrap"
    );
    assert(owner, `${selector} has no shared label owner`);
    assertEquals(owner.declarations.get("flex-shrink"), "0");
  }
  for (const [path, css] of sources) {
    if (!path.endsWith(".css") || path === "packages/ui/theme.css") continue;
    assertEquals(labelOverrides(css, classes), [], path);
  }
  for (
    const selector of [
      "button",
      ".otk-pill",
      ".otk-tool-error-toggle",
      ".otk-tab-open",
      '[role="button"]',
      ".outer > button:hover",
    ]
  ) {
    assert(
      labelOverrides(`${selector} { white-space: normal }`, classes).length > 0,
      selector,
    );
    assert(
      labelOverrides(`${selector} { white-space: nowrap }`, classes).length > 0,
      selector,
    );
  }
  assertEquals(
    labelOverrides("button .prose { white-space: pre-wrap }", classes),
    [],
  );
});
