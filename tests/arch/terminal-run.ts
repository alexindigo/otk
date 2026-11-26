// SPDX-License-Identifier: LGPL-3.0-only
import { Source } from "./analysis.ts";
import { property, type t } from "./syntax.ts";

function encodesPaste(node: t.Node): boolean {
  return (node.type === "CallExpression" ||
    node.type === "OptionalCallExpression") &&
    property(node.callee) === "encodePaste";
}

export function terminalRunErrors(
  files: ReadonlyMap<string, string>,
): string[] {
  const errors: string[] = [];
  for (const [path, text] of files) {
    if (
      !/\.(?:[cm]?[jt]sx?)$/.test(path) ||
      !/pasteAndSubmit|encodePaste/.test(text)
    ) {
      continue;
    }
    const source = new Source(text, path);
    const report = (node: t.Node, rule: string) =>
      errors.push(`${path}:${node.loc?.start.line}: ${rule}`);
    for (const node of source.all) {
      if (node.type === "Identifier" && node.name === "pasteAndSubmit") {
        report(node, "Use separate terminal paste and submit primitives");
      }
      if (
        node.type === "BinaryExpression" && node.operator === "+" &&
        (encodesPaste(node.left) || encodesPaste(node.right))
      ) {
        report(node, "Do not append input bytes to a paste encoding");
      }
    }
  }
  return errors;
}
