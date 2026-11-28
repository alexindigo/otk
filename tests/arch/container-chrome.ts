// SPDX-License-Identifier: LGPL-3.0-only
import { nodes, parse, property, type t } from "./syntax.ts";

const tabsPath = "packages/ui/components/Tabs.tsx";
const collections = new Set(["Tabs", "TabStrip"]);
const chrome = new Set([
  "actions",
  "leading",
  "trailing",
  "header",
  "titleAction",
]);
const frameRoots = [
  "Surface",
  "SidebarRail",
  "Dialog",
  "Popover",
  "Menu",
  "Takeover",
];
const counts = new Set(["length", "count", "size"]);

function attribute(opening: t.JSXOpeningElement, name: string) {
  return opening.attributes.find((attr): attr is t.JSXAttribute =>
    attr.type === "JSXAttribute" && property(attr.name) === name
  )?.value;
}

/** Find rendered roots, including any roots inside transparent branches. */
function* roots(node: t.Node | null | undefined): Generator<string> {
  if (!node) return;
  switch (node.type) {
    case "JSXElement": {
      const name = property(node.openingElement.name);
      if (name === "Show") {
        for (const child of node.children) yield* roots(child);
        yield* roots(attribute(node.openingElement, "fallback"));
      } else if (name) yield name;
      break;
    }
    case "JSXFragment":
      for (const child of node.children) yield* roots(child);
      break;
    case "JSXExpressionContainer":
      yield* roots(node.expression);
      break;
    case "ConditionalExpression":
      yield* roots(node.consequent);
      yield* roots(node.alternate);
      break;
    case "LogicalExpression":
      if (node.operator !== "&&") yield* roots(node.left);
      yield* roots(node.right);
      break;
    case "FunctionDeclaration":
    case "FunctionExpression":
    case "ArrowFunctionExpression":
      yield* roots(node.body);
      break;
    case "BlockStatement":
      for (const statement of node.body) yield* roots(statement);
      break;
    case "IfStatement":
      yield* roots(node.consequent);
      yield* roots(node.alternate);
      break;
    case "ReturnStatement":
      yield* roots(node.argument);
      break;
  }
}

function defaultView(tree: t.File, path: string) {
  const top = tree.program.body;
  const exported = top.find((node): node is t.ExportDefaultDeclaration =>
    node.type === "ExportDefaultDeclaration"
  )?.declaration;
  if (!exported) return;
  const basename = path.split("/").at(-1)!.slice(0, -4);
  if (exported.type === "Identifier") {
    for (const statement of top) {
      if (
        statement.type === "FunctionDeclaration" &&
        statement.id?.name === exported.name
      ) {
        return { name: exported.name, roots: [...roots(statement)] };
      }
      if (statement.type !== "VariableDeclaration") continue;
      const local = statement.declarations.find((decl) =>
        decl.id.type === "Identifier" && decl.id.name === exported.name
      );
      if (local) return { name: exported.name, roots: [...roots(local.init)] };
    }
  }
  const name = exported.type === "FunctionDeclaration"
    ? exported.id?.name ?? basename
    : basename;
  return { name, roots: [...roots(exported)] };
}

function countPredicate(node: t.Node) {
  return [...nodes(node)].some((part) =>
    (part.type === "MemberExpression" ||
      part.type === "OptionalMemberExpression") &&
    counts.has(property(part) ?? "")
  );
}

function* countGated(node: t.Node): Generator<t.Node> {
  if (
    node.type === "JSXElement" && property(node.openingElement.name) === "Show"
  ) {
    const when = attribute(node.openingElement, "when");
    if (when && countPredicate(when)) {
      yield* node.children;
      const fallback = attribute(node.openingElement, "fallback");
      if (fallback) yield fallback;
    }
  } else if (
    node.type === "LogicalExpression" && node.operator === "&&" &&
    countPredicate(node.left)
  ) {
    yield node.right;
  } else if (
    node.type === "ConditionalExpression" && countPredicate(node.test)
  ) {
    yield node.consequent;
    yield node.alternate;
  }
}

/** Frames and reply identities own their state independently of their items. */
export function containerChromeErrors(
  files: ReadonlyMap<string, string>,
): string[] {
  const errors: string[] = [];
  const sources = new Map<string, t.File>();
  const views: NonNullable<ReturnType<typeof defaultView>>[] = [];
  for (const [path, text] of files) {
    if (!path.endsWith(".tsx")) continue;
    const tree = parse(text, path);
    sources.set(path, tree);
    if (path.startsWith("packages/ui/") && path.endsWith(".tsx")) {
      const view = defaultView(tree, path);
      if (view) views.push(view);
    }
  }
  const frames = new Set(frameRoots);
  // A wrapped frame still owns chrome even when its root is another view.
  let previous: number;
  do {
    previous = frames.size;
    for (const view of views) {
      if (view.roots.some((name) => frames.has(name))) frames.add(view.name);
    }
  } while (frames.size !== previous);

  for (const [path, tree] of sources) {
    const reported = new Set<t.Node>();
    for (const node of nodes(tree)) {
      for (const branch of countGated(node)) {
        for (const part of nodes(branch)) {
          if (part.type !== "JSXOpeningElement" || reported.has(part)) continue;
          const name = property(part.name);
          if (!name || !frames.has(name)) continue;
          reported.add(part);
          errors.push(
            `${path}:${part.loc?.start.line}: ${name} must not be count-gated`,
          );
        }
      }
      if (
        node.type === "JSXOpeningElement" &&
        collections.has(property(node.name) ?? "")
      ) {
        for (const attribute of node.attributes) {
          if (attribute.type !== "JSXAttribute") continue;
          const name = property(attribute.name);
          if (name && chrome.has(name)) {
            errors.push(
              `${path}: ${property(node.name)} takes no ${name} slot`,
            );
          }
        }
      }
      if (
        path === tabsPath &&
        (node.type === "TSPropertySignature" ||
          node.type === "TSMethodSignature")
      ) {
        const name = property(node.key);
        if (name && chrome.has(name)) {
          errors.push(`${path}: tab props must not declare ${name}`);
        }
      }
    }
  }
  return errors;
}
