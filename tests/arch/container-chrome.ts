// SPDX-License-Identifier: LGPL-3.0-only
import { nodes, parse, property } from "./syntax.ts";

export function containerChromeErrors(
  files: ReadonlyMap<string, string>,
): string[] {
  const errors: string[] = [];
  for (const [path, text] of files) {
    if (!/\b(?:retainedWorkDisclosure|workDisclosure)\b/.test(text)) continue;
    for (const node of nodes(parse(text, path))) {
      if (
        node.type !== "CallExpression" && node.type !== "OptionalCallExpression"
      ) continue;
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
  return errors;
}
