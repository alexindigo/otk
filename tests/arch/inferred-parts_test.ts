// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals } from "@std/assert";
import { nodes, parse } from "./syntax.ts";

function assertions(text: string, all: boolean): number {
  return [...nodes(parse(text))].filter((node) => {
    if (node.type !== "TSAsExpression" && node.type !== "TSTypeAssertion") {
      return false;
    }
    return all ||
      [...nodes(node.expression)].some((child) =>
        child.type === "MemberExpression" &&
        child.property.type === "Identifier" &&
        child.property.name === "findLast"
      );
  }).length;
}

Deno.test("typed part callbacks and last-user selection consume inferred types without assertions", async () => {
  assertEquals(assertions('const text = "part as TextPart";', true), 0);
  assertEquals(assertions("part as TextPart", true), 1);
  assertEquals(
    assertions(
      "items.findLast(m => m.role === 'user') as UserMessage | undefined",
      false,
    ),
    1,
  );
  assertEquals(assertions("items.findLast(m => m.role === 'user')", false), 0);
  const found: string[] = [];
  for (const name of ["Agent", "Reasoning", "Text", "Tool"]) {
    const path = `packages/ui/components/parts/${name}Part.tsx`;
    if (assertions(await Deno.readTextFile(path), true)) found.push(path);
  }
  const path = "packages/ui/components/SessionView.tsx";
  if (assertions(await Deno.readTextFile(path), false)) found.push(path);
  assertEquals(found, []);
});
