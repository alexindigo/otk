// SPDX-License-Identifier: LGPL-3.0-only
import { literal, nodes, parse, property, type t } from "./syntax.ts";

type Binding = {
  scope: t.Node;
  value?: t.Node;
  suffix?: (string | t.Node)[];
  imported?: string;
  module?: string;
  exportName?: string;
  written?: boolean;
};
const functions = new Set([
  "FunctionDeclaration",
  "FunctionExpression",
  "ArrowFunctionExpression",
  "ObjectMethod",
  "ClassMethod",
  "ClassPrivateMethod",
]);
const isScope = (node: t.Node) =>
  functions.has(node.type) || [
    "Program",
    "BlockStatement",
    "CatchClause",
    "ForStatement",
    "ForInStatement",
    "ForOfStatement",
    "SwitchStatement",
    "ClassDeclaration",
    "ClassExpression",
    "StaticBlock",
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
            node.source.value,
            specifier.type === "ImportSpecifier"
              ? property(specifier.imported)
              : specifier.type === "ImportDefaultSpecifier"
              ? "default"
              : "*",
          );
        }
      } else if (node.type === "VariableDeclarator") {
        let scope = this.scope(node);
        if (
          this.parent.get(node)?.type === "VariableDeclaration" &&
          (this.parent.get(node) as t.VariableDeclaration).kind === "var"
        ) {
          while (!functions.has(scope.type) && scope.type !== "Program") {
            scope = this.scope(scope);
          }
        }
        this.bind(node.id, scope, node.init ?? undefined);
      } else if (
        node.type === "FunctionDeclaration" ||
        node.type === "FunctionExpression" ||
        node.type === "ArrowFunctionExpression" ||
        node.type === "ObjectMethod" || node.type === "ClassMethod" ||
        node.type === "ClassPrivateMethod"
      ) {
        if ("id" in node && node.id) {
          this.bind(
            node.id,
            node.type === "FunctionExpression" ? node : this.scope(node),
          );
        }
        for (const param of node.params) this.bind(param, node);
      } else if (node.type === "CatchClause" && node.param) {
        this.bind(node.param, node);
      } else if (
        (node.type === "ClassDeclaration" || node.type === "ClassExpression") &&
        node.id
      ) {
        this.bind(
          node.id,
          node.type === "ClassExpression" ? node : this.scope(node),
        );
      }
    }
    // Positive provenance never follows a stale initializer. This deliberately
    // rejects uncertain mutable dataflow instead of guessing execution order.
    for (const node of this.all) {
      const target = node.type === "AssignmentExpression"
        ? node.left
        : node.type === "UpdateExpression"
        ? node.argument
        : (node.type === "ForInStatement" || node.type === "ForOfStatement") &&
            node.left.type !== "VariableDeclaration"
        ? node.left
        : undefined;
      if (target) this.markWritten(target);
    }
  }
  private markWritten(node: t.Node): void {
    if (node.type === "Identifier") {
      const binding = this.binding(node.name, node);
      if (binding) binding.written = true;
    } else if (
      node.type === "MemberExpression" ||
      node.type === "OptionalMemberExpression"
    ) {
      this.markWritten(node.object);
    } else if (node.type === "ObjectPattern") {
      for (const item of node.properties) {
        this.markWritten(
          item.type === "ObjectProperty" ? item.value : item.argument,
        );
      }
    } else if (node.type === "ArrayPattern") {
      for (const item of node.elements) if (item) this.markWritten(item);
    } else if (node.type === "AssignmentPattern") this.markWritten(node.left);
    else if (node.type === "RestElement") this.markWritten(node.argument);
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
    suffix?: (string | t.Node)[],
    imported?: string,
    module?: string,
    exportName?: string,
  ): void {
    if (pattern.type === "Identifier") {
      const entries = this.bindings.get(pattern.name) ?? [];
      entries.push({ scope, value, suffix, imported, module, exportName });
      this.bindings.set(pattern.name, entries);
    } else if (pattern.type === "AssignmentPattern") {
      // A default is conditional on an unknown caller/property value. Neither
      // branch alone establishes provenance, but the binding still shadows.
      this.bind(pattern.left, scope);
    } else if (pattern.type === "RestElement") {
      this.bind(pattern.argument, scope);
    } else if (pattern.type === "ObjectPattern") {
      for (const item of pattern.properties) {
        if (item.type === "ObjectProperty") {
          // Computed keys resolve at use after all declarations and writes have
          // been indexed; constructor order cannot grant stale-key authority.
          const key = item.computed ? item.key : property(item.key);
          this.bind(
            item.value,
            scope,
            key === undefined ? undefined : value,
            key === undefined ? undefined : [...suffix ?? [], key],
          );
        } else this.bind(item.argument, scope);
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
  private initialized(binding: Binding, at: t.Node): boolean {
    // This lexical model does not infer call order. A later initializer cannot
    // authorize an earlier use, including a use in its own initializer.
    return !binding.value ||
      (binding.value.end !== null && binding.value.end !== undefined &&
        at.start !== null && at.start !== undefined &&
        binding.value.end <= at.start);
  }
  private fields(binding: Binding): string[] | undefined {
    const fields =
      binding.suffix?.map((key) =>
        typeof key === "string" ? key : this.string(key)
      ) ?? [];
    return fields.every((field): field is string => field !== undefined)
      ? fields
      : undefined;
  }
  value(
    node: t.Node | null | undefined,
    seen = new Set<t.Node>(),
  ): t.Node | undefined {
    if (!node || seen.has(node)) return node ?? undefined;
    seen.add(node);
    if (node.type === "Identifier") {
      const binding = this.binding(node.name, node);
      if (
        binding?.value && !binding.suffix?.length && !binding.written &&
        this.initialized(binding, node)
      ) {
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
      if (
        binding?.value && !binding.written && this.initialized(binding, node)
      ) {
        const base = this.name(binding.value, seen);
        const fields = this.fields(binding);
        return base && fields ? [base, ...fields].join(".") : node.name;
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
  /** Identity and access path, distinct from name()'s diagnostic spelling.
   * Unresolved/local/imported homonyms must not authorize shared ownership. */
  access(
    node: t.Node | null | undefined,
    seen = new Set<t.Node>(),
  ): { binding: Binding; fields: string[] } | undefined {
    if (!node || seen.has(node)) return;
    seen.add(node);
    if (node.type === "Identifier" || node.type === "JSXIdentifier") {
      const binding = this.binding(node.name, node);
      if (!binding || binding.written || !this.initialized(binding, node)) {
        return;
      }
      const fields = this.fields(binding);
      if (!fields) return;
      const base = binding.value && this.access(binding.value, seen);
      return base
        ? {
          binding: base.binding,
          fields: [...base.fields, ...fields],
        }
        : { binding, fields };
    }
    if (
      node.type === "MemberExpression" ||
      node.type === "OptionalMemberExpression" ||
      node.type === "JSXMemberExpression"
    ) {
      const base = this.access(node.object, seen);
      const field = "computed" in node && node.computed
        ? this.string(node.property)
        : property(node.property);
      return base && field
        ? { binding: base.binding, fields: [...base.fields, field] }
        : undefined;
    }
    if (
      node.type === "TSAsExpression" || node.type === "TSNonNullExpression" ||
      node.type === "TSSatisfiesExpression" ||
      node.type === "JSXExpressionContainer"
    ) {
      return this.access(node.expression, seen);
    }
  }
  imported(
    node: t.Node | null | undefined,
  ): { module: string; name: string } | undefined {
    const access = this.access(node);
    if (!access?.binding.module || !access.binding.exportName) return;
    const { module, exportName } = access.binding;
    if (exportName === "*" && access.fields.length === 1) {
      return { module, name: access.fields[0] };
    }
    if (!access.fields.length) return { module, name: exportName };
  }
  function(node: t.Node): t.Node | undefined {
    let current: t.Node | undefined = node;
    while (current && !functions.has(current.type)) {
      current = this.parent.get(current);
    }
    return current;
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
      if (
        parent.type === "ConditionalExpression" &&
        parent.test.type === "BooleanLiteral"
      ) {
        if (
          child === parent.consequent && !parent.test.value ||
          child === parent.alternate && parent.test.value
        ) return false;
      }
      if (
        parent.type === "LogicalExpression" &&
        parent.left.type === "BooleanLiteral" &&
        child === parent.right &&
        (parent.operator === "&&" && !parent.left.value ||
          parent.operator === "||" && parent.left.value)
      ) return false;
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
