// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals } from "@std/assert";
import { productionSources, Source } from "./analysis.ts";
import { literal, property } from "./syntax.ts";

/** Stdout is a machine protocol, never a diagnostics transport. */
function violations(text: string, path = "fixture.ts"): string[] {
  const source = new Source(text, path);
  const found: string[] = [];
  for (const node of source.all) {
    if (node.type !== "MemberExpression") continue;
    const owner = source.name(node.object);
    const key = node.computed
      ? literal(node.property)
      : property(node.property);
    if (
      owner === "console" && key !== "warn" && key !== "error" ||
      ["Deno", "process"].includes(owner ?? "") && key === "stdout"
    ) found.push(`${path}:${node.loc?.start.line}`);
  }
  for (const node of source.all) {
    if (node.type !== "ImportDeclaration") continue;
    if (["node:process", "process"].includes(node.source.value)) {
      for (const item of node.specifiers) {
        if (
          item.type === "ImportSpecifier" &&
          property(item.imported) === "stdout"
        ) {
          found.push(`${path}:${item.loc?.start.line}`);
        }
      }
    }
  }
  return found;
}
Deno.test("stdout guard detects console aliases, computed methods and direct writers", () => {
  for (
    const text of [
      'console.info("settings")',
      'const log = console.log; log("settings")',
      'console[level]("settings")',
      "const output = Deno.stdout; output.write(bytes)",
      'process.stdout.write("settings")',
      'import { stdout as out } from "node:process"; out.write("settings")',
    ]
  ) assertEquals(violations(text).length > 0, true, text);
  assertEquals(
    violations('console.error("settings"); console.warn("settings")'),
    [],
  );
});
Deno.test("store, core and harness diagnostics never write protocol stdout", async () => {
  const found: string[] = [];
  for (const [path, text] of await productionSources()) {
    if (
      !path.startsWith("core/") && !path.startsWith("packages/store/") &&
      !path.startsWith("packages/harness")
    ) continue;
    found.push(...violations(text, path));
  }
  assertEquals(found, []);
});
