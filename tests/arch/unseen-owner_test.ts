// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals } from "@std/assert";
import { Source } from "./analysis.ts";
import { nodes, property } from "./syntax.ts";

function reconstructsUnseen(text: string): boolean {
  const ast = new Source(text);
  const names = (node: Parameters<typeof nodes>[0]) =>
    new Set(
      [...nodes(node)].flatMap((n) =>
        n.type === "Identifier"
          ? [n.name]
          : n.type === "StringLiteral"
          ? [n.value]
          : []
      ),
    );
  return ast.all.some((node) => {
    if (
      node.type !== "BinaryExpression" ||
      ![">", "<", ">=", "<="].includes(node.operator)
    ) return false;
    const left = names(node.left), right = names(node.right);
    const finish = (set: Set<string>) =>
      ["terminal", "finish", "finishes"].some((n) => set.has(n));
    const seen = (set: Set<string>) =>
      ["seen", "acknowledged"].some((n) => set.has(n));
    return finish(left) && seen(right) || seen(left) && finish(right);
  });
}
Deno.test("unseen consumer guard catches direct computed and optional finish/seen comparisons", () => {
  for (
    const text of [
      "const unseen=inbox.finishes[id]>inbox.seen[id]",
      "const unread=entry?.terminal>marks['seen']",
      "const unread=acknowledged < terminal",
    ]
  ) assertEquals(reconstructsUnseen(text), true);
  assertEquals(
    reconstructsUnseen("const unread=supervision?.unseen===true"),
    false,
  );
});
Deno.test("attention consumers borrow supervision unseen instead of interpreting finish and seen marks", () => {
  const paths = [
    "core/index/project-summaries.ts",
    "core/features/inbox.ts",
    "packages/client/inbox.ts",
    "packages/client/notification-triggers.ts",
    "packages/client/server-resources.ts",
  ];
  for (const path of paths) {
    const source = Deno.readTextFileSync(
      new URL(`../../${path}`, import.meta.url),
    );
    assertEquals(reconstructsUnseen(source), false, path);
    // ServerResources forwards the publication; it must not also select a
    // scalar unseen verdict. The notification consumer reads the count below.
    assertEquals(
      new Source(source).all.some((n) =>
        (n.type === "MemberExpression" ||
          n.type === "OptionalMemberExpression") &&
        property(n.property) === "unseen"
      ),
      path !== "packages/client/server-resources.ts",
      path,
    );
  }
  const activity = Deno.readTextFileSync(
    new URL("../../packages/ui/entity-facts.ts", import.meta.url),
  );
  assertEquals(activity.includes("entityFacts"), true);
  assertEquals(activity.includes(".finishes"), false);
});
