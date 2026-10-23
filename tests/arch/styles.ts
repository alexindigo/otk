// SPDX-License-Identifier: LGPL-3.0-only
// @deno-types="@types/css-tree"
import * as cssTree from "css-tree";

export { cssTree };
/** Equivalent selector branches, for matching cascade targets without assuming
 * that :is()/ :where() must use one particular source spelling. */
export function selectorAlternatives(selector: string): string[] {
  const join = (parts: string[][]) =>
    parts.reduce(
      (prefixes, values) =>
        prefixes.flatMap((prefix) => values.map((value) => prefix + value)),
      [""],
    );
  const render = (node: cssTree.CssNode): string[] => {
    if (node.type === "SelectorList") {
      return node.children.toArray().flatMap(render);
    }
    if (node.type === "Selector") {
      return join(node.children.toArray().map(render));
    }
    if (
      node.type === "PseudoClassSelector" &&
      ["is", "where"].includes(node.name) && node.children
    ) return node.children.toArray().flatMap(render);
    return [cssTree.generate(node)];
  };
  return render(cssTree.parse(selector, { context: "selector" }));
}
export const unescapeCss = (text: string) =>
  text.replace(
    /\\([\da-f]{1,6})\s?|\\(.)/gi,
    (_, hex, char) => hex ? String.fromCodePoint(parseInt(hex, 16)) : char,
  );
export type Rule = {
  selector: string;
  declarations: Map<string, string>;
  condition: string;
};

/** Declarations are parsed, comments excluded and repeated selector rules
 * cascaded in order. Property spelling and !important are CSS syntax, not regex. */
export function rules(css: string): Rule[] {
  const root = cssTree.parse(css, { parseCustomProperty: true });
  const result = new Map<string, Rule>();
  function visit(
    node: cssTree.CssNode,
    ancestors: string[] = [],
    condition = "",
  ): void {
    if (node.type === "StyleSheet" || node.type === "Block") {
      node.children.forEach((child) => visit(child, ancestors, condition));
    } else if (node.type === "Atrule") {
      if (node.block) {
        visit(
          node.block,
          ancestors,
          [
            condition,
            `@${node.name} ${
              node.prelude ? cssTree.generate(node.prelude) : ""
            }`,
          ].filter(Boolean).join("/"),
        );
      }
    } else if (node.type === "Raw") {
      // CSS-tree's declaration fallback retains implicit nesting as Raw. Parse
      // that complete rule list, then require real rules rather than skipping it.
      const recovered = cssTree.parse(node.value, {
        parseCustomProperty: true,
      });
      if (
        recovered.type !== "StyleSheet" || recovered.children.isEmpty ||
        recovered.children.some((child) =>
          child.type !== "Rule" && child.type !== "Atrule"
        )
      ) throw new Error(`Unparsed CSS: ${node.value}`);
      visit(recovered, ancestors, condition);
    } else if (node.type === "Rule") {
      if (node.prelude.type !== "SelectorList") {
        throw new Error("Unparsed CSS selector");
      }
      const selectors = node.prelude.type === "SelectorList"
        ? node.prelude.children.toArray()
        : [node.prelude];
      const resolved: string[] = [];
      for (const selector of selectors) {
        const normalized = unescapeCss(cssTree.generate(selector)).trim();
        for (const parent of ancestors.length ? ancestors : [""]) {
          resolved.push(
            parent
              ? normalized.includes("&")
                ? normalized.replaceAll("&", parent)
                : `${parent} ${normalized}`
              : normalized,
          );
        }
      }
      for (const selector of resolved) {
        const key = condition + ":" + selector;
        const found = result.get(key) ??
          { selector, condition, declarations: new Map() };
        node.block.children.forEach((child) => {
          if (child.type !== "Declaration") return;
          const prop = unescapeCss(child.property).toLowerCase();
          const old = found.declarations.get(prop);
          if (!old?.endsWith("!important") || child.important) {
            found.declarations.set(
              prop,
              unescapeCss(cssTree.generate(child.value)) +
                (child.important ? " !important" : ""),
            );
          }
        });
        result.set(key, found);
      }
      node.block.children.forEach((child) => {
        if (child.type !== "Declaration") visit(child, resolved, condition);
      });
    }
  }
  visit(root);
  return [...result.values()];
}

export function words(value: string): string[] {
  const result: string[] = [];
  cssTree.walk(
    cssTree.parse(value.replace(/\s*!important$/, ""), { context: "value" }),
    (node) => {
      if (node.type === "Identifier") result.push(unescapeCss(node.name));
      else if (node.type === "String" || node.type === "Number") {
        result.push(unescapeCss(node.value));
      } else if (node.type === "Dimension") {
        result.push(node.value + unescapeCss(node.unit));
      }
    },
  );
  return result;
}

export function variables(
  value: string,
): { name: string; fallback: boolean }[] {
  const result: { name: string; fallback: boolean }[] = [];
  cssTree.walk(
    cssTree.parse(value.replace(/\s*!important$/, ""), {
      context: "value",
      parseCustomProperty: true,
    }),
    (node) => {
      if (node.type === "Function" && node.name === "var") {
        const children = node.children.toArray();
        const first = children[0];
        if (first?.type === "Identifier") {
          result.push({
            name: unescapeCss(first.name),
            fallback: children.some((n) =>
              n.type === "Operator" && n.value === ","
            ),
          });
        }
      }
    },
  );
  return result;
}

const px = (word: string): number | undefined => {
  const match = /^(-?\d*\.?\d+)(px|rem|pt|pc|in|cm|mm|q)$/i.exec(word);
  const units: Record<string, number> = {
    px: 1,
    rem: 13,
    pt: 96 / 72,
    pc: 16,
    in: 96,
    cm: 96 / 2.54,
    mm: 96 / 25.4,
    q: 96 / 101.6,
  };
  return match ? Number(match[1]) * units[match[2].toLowerCase()] : undefined;
};

export function typographyErrors(css: string, base = false): string[] {
  const result: string[] = [];
  for (const rule of rules(css)) {
    for (const [prop, value] of rule.declarations) {
      if (prop === "font-family" || prop === "font") {
        if (
          !base &&
          !["inherit", "initial", "unset", "revert", "revert-layer"].includes(
            value,
          )
        ) {
          const family = prop === "font-family"
            ? value
            : value.slice(value.lastIndexOf(" ") + 1);
          if (
            !variables(family).some((v) =>
              v.name === "--font-ui" || v.name === "--font-mono"
            )
          ) {
            result.push("font bypasses tokens");
          }
        }
      }
      if (prop === "font-size" || prop === "font") {
        const size = words(value).map(px).find((v) => v !== undefined);
        if (size !== undefined && size < 12) result.push("text below 12px");
      }
      if (/^(?:padding|margin|gap)(?:-|$)/.test(prop)) {
        for (const token of words(value)) {
          if (
            /rem$/i.test(token) ||
            /px$/i.test(token) && Number(token.slice(0, -2)) % 4 !== 0
          ) result.push("spacing bypasses 4px grid");
        }
      }
    }
  }
  return result;
}

export function outOfFlow(declarations: ReadonlyMap<string, string>): boolean {
  return [...declarations].some(([prop, value]) =>
    prop === "position" &&
      words(value).some((word) => word === "absolute" || word === "fixed") ||
    /^(?:top|bottom|left|right|inset)(?:-|$)/.test(prop) &&
      declarations.get("position") !== "sticky" ||
    /^margin(?:-|$)/.test(prop) &&
      words(value).some((word) => /^-\d/.test(word))
  );
}
