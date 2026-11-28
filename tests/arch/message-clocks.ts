// SPDX-License-Identifier: LGPL-3.0-only
import { Source } from "./analysis.ts";
import { type t } from "./syntax.ts";

/** Follow rendered components from a header role, independent of filenames.
 * A preview's body and the shared footer are separate presentation surfaces. */
export function messageHeaderClockErrors(
  files: ReadonlyMap<string, string>,
): string[] {
  const sources = new Map(
    [...files].filter(([path]) => path.endsWith(".tsx")).map((
      [path, text],
    ) => [path, new Source(text, path)]),
  );
  const resolve = (
    source: Source,
    name: t.Node,
  ): [Source, t.Node] | undefined => {
    const imported = source.imported(name);
    if (imported?.module.startsWith(".")) {
      const path = new URL(
        imported.module,
        new URL(source.path, "https://otk.invalid/"),
      ).pathname.slice(1);
      const target = sources.get(path);
      if (!target) return;
      for (const node of target.all) {
        if (
          imported.name === "default" &&
          node.type === "ExportDefaultDeclaration"
        ) return [target, target.value(node.declaration) ?? node.declaration];
        if (
          node.type === "FunctionDeclaration" && node.id?.name === imported.name
        ) return [target, node];
        if (
          node.type === "VariableDeclarator" && node.id.type === "Identifier" &&
          node.id.name === imported.name && node.init
        ) return [target, node.init];
      }
    }
    const label = source.name(name);
    const local = label && source.binding(label, name)?.value;
    if (local) return [source, local];
    const fn = source.all.find((node) =>
      node.type === "FunctionDeclaration" && node.id?.name === label
    );
    if (fn) return [source, fn];
    return undefined;
  };
  const clock = (source: Source, node: t.Node, seen: Set<t.Node>): boolean => {
    if (seen.has(node) || !source.live(node)) return false;
    seen.add(node);
    if (node.type === "JSXElement") {
      const imported = source.imported(node.openingElement.name);
      if (imported?.module.endsWith("/Clock.tsx")) return true;
      if (
        imported && /\/(?:MessageFooter|Popover)\.tsx$/.test(imported.module)
      ) return false;
      const target = resolve(source, node.openingElement.name);
      if (target && clock(...target, seen)) return true;
    }
    return Object.entries(node).some(([key, value]) =>
      ![
        "loc",
        "comments",
        "leadingComments",
        "trailingComments",
        "innerComments",
      ].includes(key) &&
      (Array.isArray(value) ? value : [value]).some((child) =>
        child && typeof child === "object" && typeof child.type === "string" &&
        clock(source, child as t.Node, seen)
      )
    );
  };
  const errors: string[] = [];
  for (const source of sources.values()) {
    for (const node of source.all) {
      if (node.type !== "JSXElement") continue;
      const opening = node.openingElement;
      const classValue = source.attr(opening, "class");
      const messageRole = classValue &&
        source.all.some((value) =>
          value.start! >= classValue.start! && value.end! <= classValue.end! &&
          value.type === "StringLiteral" &&
          /(?:^|\s)otk-(?:message-header|reply-start)(?:\s|$)/.test(
            value.value,
          )
        );
      const role = messageRole ||
        opening.attributes.some((attr) =>
          attr.type === "JSXAttribute" && attr.name.type === "JSXIdentifier" &&
          ["data-message-header", "data-reply-source"].includes(attr.name.name)
        );
      if (role && clock(source, node, new Set())) {
        errors.push(
          `${source.path}:${node.loc?.start.line}: header clock outside MessageFooter`,
        );
      }
    }
  }
  return errors;
}
