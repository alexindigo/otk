// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals } from "@std/assert";
import { cssTree, rules, words } from "./styles.ts";
import { Source, uiSources } from "./analysis.ts";
import { focusBypasses } from "./bypasses.ts";
focusBypasses(focusErrors);

const controls =
  ':where(button, input, textarea, select, a[href], summary, [contenteditable="true"], [role="button"], [role="tab"], [role="separator"], [data-otk-focus="content"]):focus-visible:not([tabindex="-1"])';
const compact = (text: string) => text.replace(/\s+/g, "");
const normalized = (selector: string) =>
  compact(rules(`${selector} {}`)[0].selector).replace(
    /:where\(([^()]*)\)/g,
    (_, items: string) => `:where(${items.split(",").sort().join(",")})`,
  );

/** An allowlist prevents even browser-focusable, unlabelled scroll wrappers
 * from inheriting interactive paint. Merely adding tabindex is never enough. */
export function focusErrors(
  css: string,
  shared = true,
  component = "",
): string[] {
  const errors: string[] = [];
  let rings = 0;
  const parsed = rules(css);
  for (const rule of parsed) {
    const outline = [...rule.declarations].filter(([prop]) =>
      /^(?:outline|outline-style|outline-width|outline-color)$/.test(prop)
    );
    let directFocus = false;
    cssTree.walk(cssTree.parse(rule.selector, { context: "selector" }), {
      enter(node: cssTree.CssNode) {
        if (node.type === "PseudoClassSelector" && node.name === "has") {
          return cssTree.walk.skip;
        }
        if (
          node.type === "PseudoClassSelector" && node.name === "focus-visible"
        ) directFocus = true;
      },
    });
    if (
      !directFocus ||
      !outline.some(([, value]) =>
        !words(value).every((word) =>
          ["none", "0", "0px", "!important"].includes(word)
        )
      )
    ) continue;
    rings++;
    const source = component ? new Source(component) : undefined;
    const classes: string[] = [];
    const selector = cssTree.parse(rule.selector, { context: "selector" });
    const subject = selector.type === "Selector"
      ? selector.children.toArray().slice(
        selector.children.toArray().findLastIndex((node) =>
          node.type === "Combinator"
        ) + 1,
      )
      : [];
    const nativeControl = subject.some((node) =>
      node.type === "TypeSelector" &&
      ["button", "input", "textarea", "select", "summary"].includes(node.name)
    );
    for (const node of subject) {
      if (node.type === "ClassSelector") classes.push(node.name);
    }
    const targets = source?.all.filter((node) =>
      node.type === "JSXOpeningElement" && classes.length &&
      classes.every((name) =>
        source.string(source.attr(node, "class"))?.split(/\s+/).includes(name)
      )
    ) ?? [];
    const semantic = source && targets.length > 0 && targets.every((node) =>
      node.type === "JSXOpeningElement" &&
      (["button", "input", "textarea", "select", "summary"].includes(
        source.name(node.name) ?? "",
      ) ||
        ["button", "tab", "separator"].includes(
          source.string(source.attr(node, "role")) ?? "",
        ) || source.string(source.attr(node, "data-otk-focus")) === "content")
    );
    if (
      normalized(rule.selector) !== normalized(controls) &&
      !(!shared && (nativeControl || semantic))
    ) {
      errors.push("layout wrapper can acquire the interactive ring");
    }
  }
  if (shared && rings !== 1) {
    errors.push("one shared interactive focus policy required");
  }
  if (
    shared && !parsed.some((rule) =>
      rule.selector === ":focus-visible" &&
      rule.declarations.get("outline") === "none"
    )
  ) {
    errors.push("layout focus must suppress the native outline");
  }
  return errors;
}

Deno.test("shared focus paint excludes programmatic landmarks, docks, scroll regions and overlay wrappers", async () => {
  const css = await Deno.readTextFile(
    new URL("../../packages/ui/theme.css", import.meta.url),
  );
  assertEquals(focusErrors(css), []);
  const files = await uiSources();
  for (const [path, source] of files) {
    if (path.endsWith(".css") && path !== "packages/ui/theme.css") {
      assertEquals(
        focusErrors(
          source,
          false,
          files.get(path.replace(/\.css$/, ".tsx")) ?? "",
        ),
        [],
        path,
      );
    }
  }
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

Deno.test("A12 component focus accepts field delegation and actual semantic class targets", () => {
  assertEquals(
    focusErrors(
      `
    .answer:has(input:focus-visible) { outline: 3px solid red; }
    .resize:focus-visible { outline-width: 3px; outline-style: solid; }
    textarea:focus-visible { outline: 3px solid red; }
  `,
      false,
      `
    export function Fields() {
      return <div class="answer"><input /><div class={"resize"} role="separator" /></div>;
    }
  `,
    ),
    [],
  );
});
