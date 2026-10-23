// SPDX-License-Identifier: LGPL-3.0-only
import { literal, nodes, parse, property, type t } from "./syntax.ts";

type Binding = {
  scope: t.Node;
  value?: t.Node;
  suffix?: string;
  imported?: string;
};
const isScope = (node: t.Node) =>
  [
    "Program",
    "BlockStatement",
    "FunctionDeclaration",
    "FunctionExpression",
    "ArrowFunctionExpression",
    "CatchClause",
  ].includes(node.type);

/** A read-only, lexical source model. Names resolve from the use site, so a
 * renamed import/const is equivalent, while a shadowing parameter is distinct. */
export class Source {
  readonly tree: t.File;
  readonly all: t.Node[];
  readonly parent = new Map<t.Node, t.Node>();
  readonly bindings = new Map<string, Binding[]>();
  constructor(readonly text: string, readonly path = "fixture.tsx") {
    this.tree = parse(text, path);
    this.all = [...nodes(this.tree)];
    for (const node of this.all) {
      for (const [key, value] of Object.entries(node)) {
        if (
          [
            "comments",
            "leadingComments",
            "trailingComments",
            "innerComments",
            "errors",
          ].includes(key)
        ) continue;
        for (const child of Array.isArray(value) ? value : [value]) {
          if (
            child && typeof child === "object" && typeof child.type === "string"
          ) this.parent.set(child, node);
        }
      }
    }
    for (const node of this.all) {
      if (node.type === "ImportDeclaration") {
        for (const specifier of node.specifiers) {
          this.bind(
            specifier.local,
            this.scope(node),
            undefined,
            undefined,
            specifier.type === "ImportSpecifier"
              ? property(specifier.imported)
              : specifier.type === "ImportDefaultSpecifier"
              ? node.source.value.split("/").at(-1)?.replace(/\.[^.]+$/, "")
              : "*",
          );
        }
      } else if (node.type === "VariableDeclarator") {
        this.bind(node.id, this.scope(node), node.init ?? undefined);
      } else if (
        node.type === "FunctionDeclaration" ||
        node.type === "FunctionExpression" ||
        node.type === "ArrowFunctionExpression" ||
        node.type === "ObjectMethod" || node.type === "ClassMethod"
      ) {
        if ("id" in node && node.id) this.bind(node.id, this.scope(node));
        for (const param of node.params) this.bind(param, node);
      }
    }
  }
  scope(node: t.Node): t.Node {
    let current = this.parent.get(node);
    while (current && !isScope(current)) current = this.parent.get(current);
    return current ?? this.tree.program;
  }
  private bind(
    pattern: t.Node,
    scope: t.Node,
    value?: t.Node,
    suffix?: string,
    imported?: string,
  ): void {
    if (pattern.type === "Identifier") {
      const entries = this.bindings.get(pattern.name) ?? [];
      entries.push({ scope, value, suffix, imported });
      this.bindings.set(pattern.name, entries);
    } else if (pattern.type === "AssignmentPattern") {
      this.bind(pattern.left, scope, value ?? pattern.right, suffix);
    } else if (pattern.type === "ObjectPattern") {
      for (const item of pattern.properties) {
        if (item.type === "ObjectProperty") {
          this.bind(
            item.value,
            scope,
            value,
            [suffix, property(item.key)].filter(Boolean).join("."),
          );
        }
      }
    } else if (pattern.type === "ArrayPattern") {
      for (const item of pattern.elements) if (item) this.bind(item, scope);
    }
  }
  binding(name: string, at: t.Node): Binding | undefined {
    let current: t.Node | undefined = at;
    while (current) {
      const found = this.bindings.get(name)?.findLast((item) =>
        item.scope === current
      );
      if (found) return found;
      current = this.parent.get(current);
    }
  }
  value(
    node: t.Node | null | undefined,
    seen = new Set<t.Node>(),
  ): t.Node | undefined {
    if (!node || seen.has(node)) return node ?? undefined;
    seen.add(node);
    if (node.type === "Identifier") {
      const binding = this.binding(node.name, node);
      if (binding?.value && !binding.suffix) {
        return this.value(binding.value, seen);
      }
    }
    if (
      node.type === "TSAsExpression" || node.type === "TSNonNullExpression" ||
      node.type === "TSSatisfiesExpression" ||
      node.type === "JSXExpressionContainer"
    ) return this.value(node.expression, seen);
    return node;
  }
  string(node: t.Node | null | undefined): string | undefined {
    return literal(this.value(node));
  }
  name(
    node: t.Node | null | undefined,
    seen = new Set<t.Node>(),
  ): string | undefined {
    if (!node || seen.has(node)) return;
    seen.add(node);
    if (node.type === "Identifier" || node.type === "JSXIdentifier") {
      const binding = this.binding(node.name, node);
      if (binding?.imported) return binding.imported;
      if (binding?.value) {
        const base = this.name(binding.value, seen);
        return base
          ? [base, binding.suffix].filter(Boolean).join(".")
          : node.name;
      }
      return node.name;
    }
    if (
      node.type === "MemberExpression" ||
      node.type === "OptionalMemberExpression" ||
      node.type === "JSXMemberExpression"
    ) {
      const base = this.name(node.object, seen);
      const field = "computed" in node && node.computed
        ? this.string(node.property)
        : property(node.property);
      return base && field ? `${base}.${field}` : undefined;
    }
    if (
      node.type === "CallExpression" || node.type === "OptionalCallExpression"
    ) return this.name(node.callee, seen);
    if (
      node.type === "TSAsExpression" || node.type === "TSNonNullExpression" ||
      node.type === "TSSatisfiesExpression"
    ) return this.name(node.expression, seen);
  }
  attr(node: t.JSXOpeningElement, name: string): t.Node | undefined {
    const attr = node.attributes.find((a) =>
      a.type === "JSXAttribute" && property(a.name) === name
    );
    return attr?.type === "JSXAttribute" ? attr.value ?? undefined : undefined;
  }
  /** Statically dead branches cannot satisfy a positive wiring obligation. */
  live(node: t.Node): boolean {
    let child = node, parent = this.parent.get(child);
    while (parent) {
      if (
        parent.type === "IfStatement" && parent.test.type === "BooleanLiteral"
      ) {
        if (
          child === parent.consequent && !parent.test.value ||
          child === parent.alternate && parent.test.value
        ) return false;
      }
      if (parent.type === "BlockStatement" || parent.type === "Program") {
        const index = parent.body.indexOf(child as t.Statement);
        if (
          index >= 0 &&
          parent.body.slice(0, index).some((s) =>
            s.type === "ReturnStatement" || s.type === "ThrowStatement"
          )
        ) return false;
      }
      child = parent;
      parent = this.parent.get(child);
    }
    return true;
  }
  calls(name: string): (t.CallExpression | t.OptionalCallExpression)[] {
    return this.all.filter((
      n,
    ): n is t.CallExpression | t.OptionalCallExpression =>
      (n.type === "CallExpression" || n.type === "OptionalCallExpression") &&
      this.name(n.callee)?.split(".").at(-1) === name && this.live(n)
    );
  }
}

/** Shared recursive inventory. Dependency boundaries also cover test consumers;
 * ownership policies use the production-only projection below. */
export async function sourceInventory(
  { root = new URL("../../", import.meta.url), tests = false }: {
    root?: URL;
    tests?: boolean;
  } = {},
): Promise<Map<string, string>> {
  const files = new Map<string, string>();
  async function read(directory: URL, prefix: string): Promise<void> {
    for await (const entry of Deno.readDir(directory)) {
      if (
        ["node_modules", "dist", ".git", ".test-state", "tmp"]
          .includes(entry.name) ||
        (!tests && entry.name === "tests") ||
        (prefix === "tests/" && entry.name === "arch")
      ) continue;
      const path = prefix + entry.name;
      const url = new URL(
        encodeURIComponent(entry.name) + (entry.isDirectory ? "/" : ""),
        directory,
      );
      if (entry.isDirectory) await read(url, path + "/");
      else if (/\.(?:[cm]?[jt]sx?|css)$/.test(entry.name)) {
        files.set(path, await Deno.readTextFile(url));
      }
    }
  }
  for (
    const directory of [
      "packages/",
      "core/",
      "web/src/",
      ...(tests ? ["tests/"] : []),
    ]
  ) {
    await read(new URL(directory, root), directory);
  }
  for (const path of ["main.ts", "application.ts"]) {
    files.set(path, await Deno.readTextFile(new URL(path, root)));
  }
  return files;
}

export const productionSources = (root?: URL) => sourceInventory({ root });

export const uiSources = async () =>
  new Map(
    [...(await productionSources())].filter(([path]) =>
      path.startsWith("packages/ui/") || path.startsWith("web/src/")
    ),
  );

export function dependencySpecifiers(source: string): (string | undefined)[] {
  const result: (string | undefined)[] = [];
  const specifier = (node: t.Node | undefined): string | undefined => {
    if (
      node?.type === "StringLiteral" && String(node.extra?.raw).includes("\\")
    ) return;
    if (
      node?.type === "TemplateLiteral" &&
      node.quasis.some((q) => q.value.raw.includes("\\"))
    ) return;
    return literal(node);
  };
  for (const node of new Source(source).all) {
    if (
      node.type === "ImportDeclaration" ||
      node.type === "ExportNamedDeclaration" ||
      node.type === "ExportAllDeclaration"
    ) {
      if (node.source) result.push(specifier(node.source));
    } else if (
      node.type === "CallExpression" && node.callee.type === "Import"
    ) {
      result.push(specifier(node.arguments[0]));
    } else if (node.type === "ImportExpression") {
      result.push(specifier(node.source));
    } else if (node.type === "TSImportType") {
      result.push(specifier(node.argument));
    } else if (node.type === "TSExternalModuleReference") {
      result.push(specifier(node.expression));
    }
  }
  return result;
}
