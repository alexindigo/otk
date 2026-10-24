// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals } from "@std/assert";
import { productionSources, Source } from "./analysis.ts";
import { property } from "./syntax.ts";

// Enum/type declarations and label/shape dictionaries don't rank states. Ordered
// value lists and numeric rank maps do; neither may grow a second owner.
function priorityDefinitions(text: string): number {
  const source = new Source(text);
  const states = new Set(["blocked", "finished", "working", "idle"]);
  return source.all.filter((node) => {
    const values = node.type === "ArrayExpression"
      ? node.elements.flatMap((e) =>
        e?.type === "StringLiteral" ? [e.value] : []
      )
      : node.type === "ObjectExpression"
      ? node.properties.flatMap((p) =>
        p.type === "ObjectProperty" &&
          p.value.type === "NumericLiteral"
          ? [property(p.key) ?? ""]
          : []
      )
      : [];
    return new Set(values.filter((v) => states.has(v))).size > 1;
  }).length;
}
Deno.test("light priority has exactly one production definition at the client inbox owner", async () => {
  const definitions: string[] = [];
  for (const [path, text] of await productionSources()) {
    if (!/\.tsx?$/.test(path)) continue;
    for (let i = 0; i < priorityDefinitions(text); i++) definitions.push(path);
  }
  assertEquals(definitions, ["packages/client/inbox.ts"]);
  const owner = new Source(await Deno.readTextFile("packages/client/inbox.ts"));
  assert(owner.all.some((n) =>
    n.type === "VariableDeclarator" &&
    owner.name(n.id) === "INBOX_STATUS_PRIORITY"
  ));
});
Deno.test("priority ownership detects reordered lists and numeric rank maps without treating labels as ranks", () => {
  for (
    const copy of [
      'const order = ["finished", "blocked", "idle", "working"];',
      "const rank = { working: 0, finished: 1, blocked: 2, idle: 3 };",
    ]
  ) assertEquals(priorityDefinitions(copy), 1);
  assertEquals(
    priorityDefinitions(
      'const labels = {working: "Working", finished: "Finished, not seen"};',
    ),
    0,
  );
});
