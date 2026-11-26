// SPDX-License-Identifier: LGPL-3.0-only
import { nodes, parse, property } from "./syntax.ts";

const tabsPath = "packages/ui/components/Tabs.tsx";
const collections = new Set(["Tabs", "TabStrip"]);
const chrome = new Set([
  "actions",
  "leading",
  "trailing",
  "header",
  "titleAction",
]);

/** Frames and reply identities own their state independently of their items. */
export function containerChromeErrors(
  files: ReadonlyMap<string, string>,
): string[] {
  const errors: string[] = [];
  for (const [path, text] of files) {
    if (
      !path.endsWith(".tsx") &&
      !/\b(?:retainedWorkDisclosure|workDisclosure)\b/.test(text)
    ) continue;
    for (const node of nodes(parse(text, path))) {
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
      if (
        node.type === "CallExpression" || node.type === "OptionalCallExpression"
      ) {
        const name = property(node.callee);
        if (
          (name === "workDisclosure" && node.arguments.length > 1) ||
          (name === "retainedWorkDisclosure" && node.arguments.length > 3)
        ) {
          errors.push(
            `${path}:${node.loc?.start.line}: ${name} must not take members`,
          );
        }
      }
    }
  }
  return errors;
}
