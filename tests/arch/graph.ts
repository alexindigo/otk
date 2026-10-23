// SPDX-License-Identifier: LGPL-3.0-only
import { Source } from "./analysis.ts";
import { nodes, property, type t } from "./syntax.ts";

/** Module resolution follows named/default/namespace imports and barrel exports.
 * The map is injectable: adversarial consumers exercise the production walker. */
export class Graph {
  readonly sources = new Map<string, Source>();
  constructor(readonly files: ReadonlyMap<string, string>) {
    for (const [path, text] of files) {
      if (/\.[cm]?[jt]sx?$/.test(path)) {
        this.sources.set(path, new Source(text, path));
      }
    }
  }
  resolve(from: string, specifier: string): string | undefined {
    if (!specifier.startsWith(".")) return;
    const path = decodeURIComponent(
      new URL(specifier, new URL(from, "file:///source/")).pathname.slice(
        "/source/".length,
      ),
    );
    return [
      path,
      `${path}.tsx`,
      `${path}.ts`,
      `${path}/index.ts`,
      `${path}/index.tsx`,
    ].find((p) => this.files.has(p));
  }
  exported(
    path: string,
    name: string,
    seen = new Set<string>(),
  ): string | undefined {
    if (seen.has(`${path}:${name}`)) return;
    seen.add(`${path}:${name}`);
    const source = this.sources.get(path);
    if (!source) return;
    for (const node of source.tree.program.body) {
      if (node.type === "ExportNamedDeclaration") {
        for (const specifier of node.specifiers) {
          if (
            specifier.type === "ExportSpecifier" &&
            property(specifier.exported) === name
          ) {
            const target = node.source && this.resolve(path, node.source.value);
            return target
              ? this.exported(target, property(specifier.local) ?? name, seen)
              : this.component(path, specifier.local, seen) ?? path;
          }
        }
        if (
          node.declaration &&
          [...nodes(node.declaration)].some((n) =>
            n.type === "Identifier" && n.name === name
          )
        ) return path;
      } else if (node.type === "ExportAllDeclaration") {
        const target = this.resolve(path, node.source.value);
        const found = target && this.exported(target, name, seen);
        if (found) return found;
      } else if (
        node.type === "ExportDefaultDeclaration" && name === "default"
      ) return this.component(path, node.declaration, seen) ?? path;
    }
    return /\.tsx$/.test(path) ? path : undefined;
  }
  component(
    path: string,
    node: t.Node,
    seen = new Set<string>(),
  ): string | undefined {
    const source = this.sources.get(path);
    if (!source) return;
    const local =
      node.type === "JSXMemberExpression" || node.type === "MemberExpression"
        ? property(node.object)
        : property(node);
    for (const statement of source.tree.program.body) {
      if (statement.type !== "ImportDeclaration") continue;
      const binding = statement.specifiers.find((s) => s.local.name === local);
      if (!binding) continue;
      const target = this.resolve(path, statement.source.value);
      if (!target) return;
      const exported = binding.type === "ImportSpecifier"
        ? property(binding.imported)
        : binding.type === "ImportNamespaceSpecifier" &&
            (node.type === "JSXMemberExpression" ||
              node.type === "MemberExpression")
        ? property(node.property)
        : "default";
      return this.exported(target, exported ?? "default", seen);
    }
  }
  references(path: string, root: t.Node): string[] {
    const result: string[] = [];
    for (const node of nodes(root)) {
      const reference = node.type === "JSXOpeningElement"
        ? node.name
        : node.type === "ObjectProperty" && property(node.key) === "component"
        ? node.value
        : undefined;
      const target = reference && this.component(path, reference);
      if (target) result.push(target);
    }
    return result;
  }
  overlays(): Set<string> {
    const result = new Set<string>();
    const queue: { path: string; root: t.Node }[] = [];
    for (const [path, source] of this.sources) {
      if (
        /components\/surface\/(?:Dialog|Popover|Menu|Toast|Takeover)\.tsx$/
          .test(path)
      ) continue;
      for (const node of source.all) {
        if (node.type === "JSXElement") {
          const name =
            this.component(path, node.openingElement.name)?.split("/").at(-1)
              ?.replace(/\.tsx$/, "") ?? source.name(node.openingElement.name);
          if (["Popover", "Menu", "Toast", "ListPicker"].includes(name ?? "")) {
            result.add(path);
            queue.push({ path, root: node });
          }
        } else if (
          node.type === "CallExpression" &&
          /(?:^|\.)dialogs\.register$/.test(source.name(node.callee) ?? "")
        ) {
          result.add(path);
          for (const argument of node.arguments) {
            queue.push({ path, root: argument });
          }
        }
      }
    }
    const followed = new Set<string>();
    for (const { path, root } of queue) {
      for (const target of this.references(path, root)) {
        if (
          /\/(?:surface|registries|shell|keyboard)\//.test(target) ||
          followed.has(target)
        ) continue;
        followed.add(target);
        result.add(target);
        const source = this.sources.get(target);
        if (source) queue.push({ path: target, root: source.tree });
      }
    }
    return result;
  }
}
