// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals } from "@std/assert";
import { productionSources } from "./analysis.ts";
import { nodes, parse } from "./syntax.ts";

function unsafeErrors(source: string): string[] {
  const tree = parse(source);
  const errors: string[] = [];
  for (const node of nodes(tree)) {
    if (node.type === "TSAnyKeyword") errors.push("explicit any");
    if (
      (node.type === "TSAsExpression" || node.type === "TSTypeAssertion") &&
      node.typeAnnotation.type === "TSTypeReference" &&
      node.typeAnnotation.typeName.type === "Identifier" &&
      node.typeAnnotation.typeName.name === "Error"
    ) errors.push("unchecked Error assertion");
  }
  if (tree.comments?.some((comment) => /@ts-ignore\b/.test(comment.value))) {
    errors.push("unchecked suppression");
  }
  return errors;
}

Deno.test("failure boundaries narrow unknown values instead of asserting Error or suppressing types", async () => {
  assertEquals(
    unsafeErrors(
      'const example = "as Error, any, @ts-ignore"; // ordinary prose',
    ),
    [],
  );
  for (
    const source of [
      "caught as Error",
      "caught as unknown as Error",
      "let value: any",
      "// @ts-ignore\nconsume(value)",
    ]
  ) {
    assert(unsafeErrors(source).length > 0, source);
  }
  const errors: string[] = [];
  for (const [path, source] of await productionSources()) {
    if (!/\.[cm]?[jt]sx?$/.test(path)) continue;
    errors.push(...unsafeErrors(source).map((error) => `${path}: ${error}`));
  }
  assertEquals(errors, []);
});
