// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals } from "@std/assert";
import { productionSources, Source } from "./analysis.ts";

Deno.test("external UTF-8 preview encoding has one native owner", async () => {
  const encoders: string[] = [];
  for (const [path, text] of await productionSources()) {
    if (
      !path.startsWith("packages/harness-opencode1/") || !path.endsWith(".ts")
    ) continue;
    if (!/previews|map-tools/.test(path)) continue;
    const source = new Source(text, path);
    for (const node of source.all) {
      if (
        node.type === "NewExpression" &&
        source.name(node.callee) === "TextEncoder"
      ) encoders.push(path);
    }
  }
  assertEquals(encoders, ["packages/harness-opencode1/previews.ts"]);
});

Deno.test("store transaction boundaries have one feature-neutral owner", async () => {
  const owners = new Set<string>();
  for (const [path, text] of await productionSources()) {
    if (!path.startsWith("packages/store/") || !path.endsWith(".ts")) continue;
    for (const node of new Source(text, path).all) {
      if (node.type === "StringLiteral" && node.value === "BEGIN IMMEDIATE") {
        owners.add(path);
      }
    }
  }
  assertEquals(owners.size, 1, [...owners].join(", "));
});

Deno.test("shell binding delegates connection facts to server resources", async () => {
  const path = "packages/ui/state/shell.ts",
    source = new Source(await Deno.readTextFile(path), path);
  const copied: string[] = [];
  for (const node of source.all) {
    if (
      node.type !== "MemberExpression" &&
      node.type !== "OptionalMemberExpression"
    ) continue;
    const name = source.name(node);
    if (/(?:^|\.)(status|capabilities|connectionVersion)$/.test(name ?? "")) {
      copied.push(name!);
    }
  }
  assertEquals(copied, []);
});
