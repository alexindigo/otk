// SPDX-License-Identifier: LGPL-3.0-only
import { THEME_SLOTS } from "../../packages/ui/theme/slots.ts";
import { Graph } from "./graph.ts";
import { cssTree, type Rule, rules, variables, words } from "./styles.ts";
import { nodes, property } from "./syntax.ts";

function inherits(selector: string, ancestor: string): boolean {
  if (selector === ancestor) return true;
  if (!selector.startsWith(ancestor)) return false;
  return /^(?:\s|>|\.|:|\[)/.test(selector.slice(ancestor.length));
}

/** A token is available from the applied theme, the consumer's own scope, an
 * imported root stylesheet, or an actual inline declaration on that component.
 * Merely occurring elsewhere in the inventory supplies no authority. */
export function tokenErrors(files: ReadonlyMap<string, string>): string[] {
  const graph = new Graph(files);
  const css = new Map(
    [...files].filter(([path]) => path.endsWith(".css")).map((
      [path, text],
    ) => [path, rules(text)]),
  );
  const global = new Set(THEME_SLOTS.map((slot) => `--otk-${slot}`));
  for (const path of ["theme.css", "packages/ui/theme.css"]) {
    for (const rule of css.get(path) ?? []) {
      if (rule.selector === ":root" && !rule.condition) {
        for (const name of rule.declarations.keys()) {
          if (name.startsWith("--")) {
            global.add(name);
          }
        }
      }
    }
  }
  const inline = new Map<string, Rule[]>();
  for (const [path, source] of graph.sources) {
    const definitions: Rule[] = [];
    for (const node of source.all) {
      if (node.type === "JSXOpeningElement") {
        const style = source.value(source.attr(node, "style"));
        const classNode = source.attr(node, "class");
        const classes = classNode
          ? [...nodes(classNode)].flatMap((n) =>
            source.string(n)?.split(/\s+/) ?? []
          ).filter((c) => /^[\w-]+$/.test(c))
          : [];
        if (style?.type !== "ObjectExpression") continue;
        const declarations = new Map<string, string>();
        for (const field of style.properties) {
          if (field.type === "ObjectProperty") {
            const name = property(field.key);
            if (name?.startsWith("--")) declarations.set(name, "inline");
          }
        }
        for (const name of classes) {
          definitions.push({
            selector: `.${name}`,
            condition: "",
            declarations,
          });
        }
      }
    }
    inline.set(path, definitions);
  }
  function loadedStyles(path: string): Set<string> {
    const result = new Set<string>([path]);
    const queue = [
      path.replace(/\.css$/, ".tsx"),
      path.replace(/\.css$/, ".ts"),
    ];
    const seen = new Set<string>();
    for (const module of queue) {
      if (seen.has(module)) continue;
      seen.add(module);
      const source = graph.sources.get(module);
      if (!source) continue;
      for (const node of source.all) {
        if (
          node.type === "ImportDeclaration" ||
          node.type === "ExportNamedDeclaration" ||
          node.type === "ExportAllDeclaration"
        ) {
          const target = node.source &&
            graph.resolve(module, node.source.value);
          if (!target) continue;
          if (target.endsWith(".css")) result.add(target);
          else queue.push(target);
        }
      }
    }
    return result;
  }
  const errors: string[] = [];
  function ancestorScope(
    path: string,
    consumer: string,
    definition: string,
  ): boolean {
    const source = graph.sources.get(path.replace(/\.css$/, ".tsx"));
    if (!source) return false;
    const parent = cssTree.parse(definition, { context: "selector" });
    if (
      parent.type !== "Selector" || parent.children.size !== 1 ||
      parent.children.first?.type !== "ClassSelector"
    ) return false;
    const parentClass = parent.children.first.name;
    const target = cssTree.parse(consumer, { context: "selector" });
    if (target.type !== "Selector") return false;
    const parts = target.children.toArray();
    const classes = parts.slice(
      parts.findLastIndex((n) => n.type === "Combinator") + 1,
    ).flatMap((n) => n.type === "ClassSelector" ? [n.name] : []);
    if (!classes.length) return false;
    const elements = source.all.filter((n) =>
      n.type === "JSXOpeningElement" &&
      classes.every((c) =>
        source.string(source.attr(n, "class"))?.split(/\s+/).includes(c)
      )
    );
    return elements.length > 0 && elements.every((element) => {
      let current = source.parent.get(element);
      while (current) {
        if (
          current.type === "JSXElement" &&
          source.string(source.attr(current.openingElement, "class"))?.split(
            /\s+/,
          ).includes(parentClass)
        ) return true;
        current = source.parent.get(current);
      }
      return false;
    });
  }
  for (const [path, consumers] of css) {
    const imported = loadedStyles(path);
    const definitions = [
      ...(css.get(path) ?? []),
      ...(inline.get(path.replace(/\.css$/, ".tsx")) ?? []),
      ...[...imported].filter((p) => p !== path).flatMap((p) =>
        (css.get(p) ?? []).filter((r) => r.selector === ":root" && !r.condition)
      ),
    ];
    for (const consumer of consumers) {
      for (const value of consumer.declarations.values()) {
        for (const token of variables(value)) {
          if (token.fallback || global.has(token.name)) {
            continue;
          }
          // Animation declarations inherit custom properties from the animated
          // element, not from the keyframe's `to` / percentage selector.
          const keyframes = consumer.condition.split("/").find((part) =>
            part.startsWith("@keyframes ")
          )?.slice("@keyframes ".length);
          const scopes = keyframes
            ? consumers.filter((rule) =>
              [...rule.declarations].some(([prop, value]) =>
                ["animation", "animation-name"].includes(prop) &&
                words(value).includes(keyframes)
              )
            )
            : [consumer];
          const available = scopes.length > 0 &&
            scopes.every((scope) =>
              definitions.some((definition) =>
                definition.declarations.has(token.name) &&
                (!definition.condition ||
                  definition.condition === scope.condition) &&
                (definition.selector === ":root" ||
                  inherits(scope.selector, definition.selector) ||
                  ancestorScope(path, scope.selector, definition.selector))
              )
            );
          if (!available) errors.push(`${path}: undefined ${token.name}`);
        }
      }
    }
  }
  return [...new Set(errors)];
}
