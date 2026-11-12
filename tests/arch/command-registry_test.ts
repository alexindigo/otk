// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals } from "@std/assert";
import { productionSources, Source } from "./analysis.ts";

function violations(path: string, text: string): string[] {
  const source = new Source(text, path), failures: string[] = [];
  for (const node of source.all) {
    if (node.type === "ObjectProperty" && source.name(node.key) === "slash") {
      failures.push("per-command slash opt-in");
    }
    if (
      (path.endsWith("/prompt/slash.ts") || path.endsWith("/Palette.tsx")) &&
      node.type === "ArrayExpression" &&
      node.elements.some((item) =>
        item?.type === "StringLiteral" &&
        /^(session|prompt|prefs)\./.test(item.value)
      )
    ) failures.push("per-surface command inventory");
  }
  return failures;
}
Deno.test("command surfaces project one registry without slash opt-in tables", async () => {
  const failures: string[] = [];
  for (const [path, text] of await productionSources()) {
    if (!/\.tsx?$/.test(path)) continue;
    if (
      !path.startsWith("packages/ui/") && path !== "packages/client/commands.ts"
    ) continue;
    failures.push(
      ...violations(path, text).map((reason) => `${path}: ${reason}`),
    );
  }
  assertEquals(failures, []);
});
Deno.test("command registry gate rejects a new slash flag and a surface command table", () => {
  assertEquals(
    violations(
      "packages/ui/features/prompt/slash.ts",
      `const a = {slash:["x"]}; const table=["session.compact"];`,
    ).length,
    2,
  );
});
