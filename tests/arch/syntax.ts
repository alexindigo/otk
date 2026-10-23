// SPDX-License-Identifier: LGPL-3.0-only
import { parse as babel } from "@babel/parser";
import type * as t from "@babel/types";

export type { t };

export function parse(source: string, path = "fixture.tsx"): t.File {
  return babel(source, {
    sourceFilename: path,
    sourceType: "module",
    plugins: ["typescript", "jsx", "importAttributes"],
    allowReturnOutsideFunction: true,
    errorRecovery: false,
  });
}

export function* nodes(node: t.Node): Generator<t.Node> {
  yield node;
  for (const [key, value] of Object.entries(node)) {
    if (
      [
        "comments",
        "leadingComments",
        "trailingComments",
        "innerComments",
        "tokens",
        "errors",
      ].includes(key)
    ) continue;
    for (const child of Array.isArray(value) ? value : [value]) {
      if (
        child && typeof child === "object" && typeof child.type === "string"
      ) yield* nodes(child as t.Node);
    }
  }
}

export function property(node: t.Node): string | undefined {
  if (node.type === "Identifier" || node.type === "JSXIdentifier") {
    return node.name;
  }
  if (node.type === "StringLiteral") return node.value;
  if (
    node.type === "MemberExpression" || node.type === "OptionalMemberExpression"
  ) return property(node.property);
}

export function literal(node: t.Node | undefined | null): string | undefined {
  if (node?.type === "StringLiteral") return node.value;
  if (node?.type === "TemplateLiteral" && node.expressions.length === 0) {
    return node.quasis[0].value.cooked ?? undefined;
  }
}
