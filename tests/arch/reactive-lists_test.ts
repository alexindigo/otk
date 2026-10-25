// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals } from "@std/assert";
import { Source, uiSources } from "./analysis.ts";
function positionalReads(text: string): number {
  const source = new Source(text);
  // Owner methods may supply contractually parallel arrays (e.g. a fixed
  // question form's answers). Local reactive collection accessors are the
  // parent-list rereads that can outlive the keyed row's former position.
  return source.all.filter((node) =>
    (node.type === "MemberExpression" ||
      node.type === "OptionalMemberExpression") &&
    node.computed && node.object.type === "CallExpression" &&
    node.object.callee.type === "Identifier" &&
    node.property.type !== "NumericLiteral" &&
    node.property.type !== "StringLiteral"
  ).length;
}
Deno.test("reactive list rows do not re-enter a changing parent collection by position", async () => {
  const errors: string[] = [];
  for (const [path, text] of await uiSources()) {
    if (!path.endsWith(".css") && positionalReads(text)) errors.push(path);
  }
  assertEquals(errors, []);
  assertEquals(positionalReads("const visible = n => crumbs()[n].id"), 1);
  assertEquals(positionalReads("group()[at() - 1]?.destructive"), 1);
  assertEquals(
    positionalReads(
      "snapshot.map((row, index) => ({row, first: index === 0}))",
    ),
    0,
  );
});
