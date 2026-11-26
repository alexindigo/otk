// SPDX-License-Identifier: LGPL-3.0-only
import { Source } from "./analysis.ts";
import { property, type t } from "./syntax.ts";

const boxes = "packages/client/terminal-boxes.ts";
const adapter = "packages/ui/terminal/adapter.ts";
const model = "packages/ui/features/terminal/model.ts";

function unwrap(node: t.Node): t.Node {
  while (
    node.type === "TSNonNullExpression" || node.type === "TSAsExpression"
  ) {
    node = node.expression;
  }
  return node;
}

function inRunTarget(node: t.Node, source: Source): boolean {
  for (
    let parent = source.parent.get(node);
    parent;
    parent = source.parent.get(parent)
  ) {
    if (parent.type === "FunctionDeclaration") {
      return parent.id?.name === "runTarget";
    }
  }
  return false;
}

function encodesPaste(node: t.Node): boolean {
  node = unwrap(node);
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
      !/pasteAndSubmit|encodePaste|TerminalRuns|\b(?:paste|submit|erase|request)\b/
        .test(text)
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
      if (
        node.type === "NewExpression" && path !== boxes &&
        property(node.callee) === "TerminalRuns"
      ) {
        report(node, "Only TerminalBox may own TerminalRuns");
      }
      if (
        node.type !== "CallExpression" && node.type !== "OptionalCallExpression"
      ) continue;
      const callee = unwrap(node.callee);
      if (
        callee.type !== "MemberExpression" &&
        callee.type !== "OptionalMemberExpression"
      ) continue;
      const method = property(callee);
      const receiver = unwrap(callee.object);
      if (
        path !== boxes && method === "request" && property(receiver) === "runs"
      ) {
        report(
          node,
          "Request terminal runs through TerminalBox.run or TerminalBox.paste",
        );
      }
      if (
        method && ["paste", "submit", "erase"].includes(method) &&
        /(?:renderer|surface|active)$/.test(property(receiver) ?? "") &&
        path !== adapter && !(path === model && inRunTarget(node, source))
      ) {
        report(node, "Terminal renderer writes go through the one run target");
      }
    }
  }
  return errors;
}
