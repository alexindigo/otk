// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals } from "@std/assert";
import { Source } from "./analysis.ts";
import { property } from "./syntax.ts";

function enumeration(source: string, name: string, receiver?: string): boolean {
  const ast = new Source(source, "consumer.ts");
  return ast.all.some((node) =>
    (node.type === "CallExpression" ||
      node.type === "OptionalCallExpression") &&
    (node.callee.type === "MemberExpression" ||
      node.callee.type === "OptionalMemberExpression") &&
    property(node.callee.property) === name &&
    (!receiver || property(node.callee.object) === receiver ||
      node.callee.object.type === "MemberExpression" &&
        property(node.callee.object.property) === receiver)
  );
}
Deno.test("attention owners keep identity worksets, keyed Activity titles and source-free tab teardown", () => {
  const read = (path: string) =>
    Deno.readTextFileSync(new URL(`../../${path}`, import.meta.url));
  assertEquals(
    enumeration(read("core/features/approvals.ts"), "values", "index"),
    false,
  );
  assertEquals(
    enumeration(read("packages/ui/features/approvals.tsx"), "entries"),
    false,
  );
  assertEquals(
    read("packages/ui/features/approvals.tsx").includes("retainActivity"),
    true,
  );
  assertEquals(
    read("packages/ui/shell/notifications.ts").includes("triggers.refresh"),
    false,
  );
  assertEquals(
    read("packages/client/notification-triggers.ts").includes(
      "Map<string, IndexEntry>",
    ),
    false,
  );
});
Deno.test("attention ownership guard detects direct and computed collection enumeration", () => {
  for (
    const source of ["index.values()", "index['values']()", "alias?.values()"]
  ) {
    assertEquals(enumeration(source, "values"), true);
  }
  for (
    const source of [
      "shell.entries().find(match)",
      "shell['entries']().find(match)",
    ]
  ) {
    assertEquals(enumeration(source, "entries"), true);
  }
  assertEquals(enumeration("shell.entry(server,id)", "entries"), false);
});
