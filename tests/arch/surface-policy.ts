// SPDX-License-Identifier: LGPL-3.0-only
import { Graph } from "./graph.ts";
import { cssTree, outOfFlow, rules, selectorAlternatives } from "./styles.ts";
import { nodes, property } from "./syntax.ts";

export function surfaceErrors(files: ReadonlyMap<string, string>): string[] {
  const errors: string[] = [];
  let graph: Graph;
  try {
    graph = new Graph(files);
  } catch {
    return ["overlay source must parse"];
  }
  const owners =
    /(?:^|\/)components\/surface\/(?:Dialog|Popover|Menu|Toast|Takeover)\.tsx$/;
  const overlay = graph.overlays();
  const card = (declarations: ReadonlyMap<string, string>) =>
    (declarations.has("background") || declarations.has("background-color")) &&
    declarations.has("border-radius") && declarations.has("box-shadow") &&
    declarations.get("box-shadow") !== "none";
  const paintOwner = (path: string) =>
    /(?:^|\/)components\/(?:surface\/Surface|ComposerTakeovers)\.css$/.test(
      path,
    ) || /(?:^|\/)theme\.css$/.test(path);
  const decorative = (path: string, selector: string) => {
    const source = graph.sources.get(path.replace(/\.css$/, ".tsx"));
    if (!source) return false;
    const parsed = cssTree.parse(selector, { context: "selector" });
    if (
      parsed.type !== "Selector" ||
      !parsed.children.toArray().every((node) => node.type === "ClassSelector")
    ) return false;
    const classes = parsed.children.toArray().flatMap((node) =>
      node.type === "ClassSelector" ? [node.name] : []
    );
    const targets = source.all.filter((node) =>
      node.type === "JSXOpeningElement" &&
      classes.every((name) =>
        source.string(source.attr(node, "class"))?.split(/\s+/).includes(name)
      )
    );
    return targets.length > 0 &&
      targets.every((node) =>
        node.type === "JSXOpeningElement" &&
        (source.string(source.attr(node, "aria-hidden")) === "true" ||
          source.string(source.attr(node, "role")) === "img")
      );
  };
  for (const [path, source] of graph.sources) {
    const loaded = new Set<string>([path.replace(/\.tsx?$/, ".css")]);
    for (const node of source.all) {
      if (node.type === "ImportDeclaration") {
        const target = graph.resolve(path, node.source.value);
        if (target?.endsWith(".css")) loaded.add(target);
      }
    }
    const styles = [...loaded].filter((p) => files.has(p) && !paintOwner(p))
      .flatMap((p) => rules(files.get(p)!));
    for (const node of source.all) {
      if (
        (node.type === "ImportDeclaration" ||
          node.type === "ExportNamedDeclaration" ||
          node.type === "ExportAllDeclaration") &&
        node.source && /(?:^|\/)Surface(?:\.tsx)?$/.test(node.source.value) &&
        !owners.test(path)
      ) errors.push(`${path}: Surface is internal`);
      if (node.type === "JSXOpeningElement") {
        const decoration =
          source.string(source.attr(node, "aria-hidden")) === "true" ||
          source.string(source.attr(node, "role")) === "img";
        const value = source.attr(node, "class");
        const classes = new Set(
          value
            ? [...nodes(value)].flatMap((n) =>
              source.string(n)?.split(/\s+/) ?? []
            )
            : [],
        );
        const cascades = new Map<string, Map<string, string>>();
        for (const rule of styles) {
          const selector = cssTree.parse(rule.selector, {
            context: "selector",
          });
          if (
            selector.type !== "Selector" ||
            !selector.children.toArray().every((part) =>
              part.type === "ClassSelector" && classes.has(part.name) ||
              part.type === "TypeSelector" &&
                part.name === source.name(node.name)
            )
          ) continue;
          const declarations = cascades.get(rule.condition) ?? new Map();
          for (const [prop, value] of rule.declarations) {
            declarations.set(prop, value);
          }
          cascades.set(rule.condition, declarations);
        }
        if (!decoration && [...cascades.values()].some(card)) {
          errors.push(`${path}: composed card paint belongs to Surface`);
        }
        if (
          source.name(node.name) === "dialog" &&
          !path.endsWith("components/surface/Dialog.tsx")
        ) errors.push(`${path}: native dialog belongs to Dialog`);
        if (
          source.attr(node, "popover") &&
          !path.endsWith("components/surface/Popover.tsx")
        ) errors.push(`${path}: native popover belongs to Popover`);
      }
      if (
        path.endsWith("components/surface/Popover.tsx") &&
        node.type === "CallExpression" &&
        property(node.callee) === "togglePopover"
      ) {
        errors.push(
          `${path}: native popovertarget association owns trigger toggling`,
        );
      }
    }
  }
  const positions = new Set([
    "components/surface/Popover.css:.otk-popover-panel",
    "components/surface/Popover.css:.otk-popover-anchor",
    "components/ProjectInbox.css:.otk-inbox-resizer",
    "components/Toasts.css:.otk-toasts",
  ]);
  for (const [path, text] of files) {
    if (!path.endsWith(".css")) continue;
    const name = path.replace(/^packages\/ui\//, "");
    const parsed = rules(text);
    for (const rule of parsed) {
      const declarations = rule.declarations;
      if (
        !paintOwner(path) && card(declarations) &&
        !decorative(path, rule.selector)
      ) errors.push(`${path}: card paint belongs to Surface`);
      if (
        /\b(?:fieldset|legend)\b/.test(rule.selector) &&
        [...declarations.keys()].some((prop) =>
          /^(?:background(?:-color)?|border-radius|box-shadow)$/.test(prop)
        )
      ) errors.push(`${path}: field grouping is not a surface`);
      if (
        name.endsWith("components/surface/Dialog.css") &&
        rule.selector.includes("[data-dialog")
      ) {
        errors.push(
          `${path}: Dialog sizes content without caller-specific rules`,
        );
      }
      const effective = new Map(declarations);
      if (
        !effective.has("position") &&
        parsed.some((other) =>
          other.condition === rule.condition &&
          other.declarations.get("position") === "sticky" &&
          selectorAlternatives(rule.selector).every((selector) =>
            selectorAlternatives(other.selector).includes(selector)
          )
        )
      ) effective.set("position", "sticky");
      if (
        (overlay.has(path.replace(/\.css$/, ".tsx")) ||
          /(?:^|\/)components\/surface\/\w+\.css$/.test(path)) &&
        !positions.has(`${name}:${rule.selector}`) && outOfFlow(effective)
      ) errors.push(`${path}: overlay content must stay in flow`);
    }
  }
  return errors;
}
