// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals } from "@std/assert";
import { productionSources, Source } from "./analysis.ts";
import { property } from "./syntax.ts";

// Enum/type declarations and label/shape dictionaries don't rank states. Ordered
// value lists and numeric rank maps do; neither may grow a second owner.
function priorityDefinitions(text: string): number {
  const source = new Source(text);
  const states = new Set(["blocked", "finished", "working", "none"]);
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
Deno.test("lamp display and attention urgency each have one definition in the shared inbox contract", async () => {
  const definitions: string[] = [];
  for (const [path, text] of await productionSources()) {
    if (!/\.tsx?$/.test(path)) continue;
    for (let i = 0; i < priorityDefinitions(text); i++) definitions.push(path);
  }
  assertEquals(definitions, [
    "packages/protocol/inbox.ts",
    "packages/protocol/inbox.ts",
  ]);
  const owner = new Source(
    await Deno.readTextFile("packages/protocol/inbox.ts"),
  );
  for (const name of ["ROLLUP_PRIORITY", "URGENCY_PRIORITY"]) {
    assert(
      owner.all.some((n) =>
        n.type === "VariableDeclarator" && owner.name(n.id) === name
      ),
    );
  }
});
Deno.test("priority ownership detects reordered lists and numeric rank maps without treating labels as ranks", () => {
  for (
    const copy of [
      'const order = ["finished", "blocked", "none", "working"];',
      "const rank = { working: 0, finished: 1, blocked: 2, none: 3 };",
    ]
  ) assertEquals(priorityDefinitions(copy), 1);
  assertEquals(
    priorityDefinitions(
      'const labels = {working: "Working", finished: "Finished, not seen"};',
    ),
    0,
  );
});

const lampConsumers = new Set([
  "core/index/entity-states.ts",
  "packages/client/entity-state.ts",
  "packages/client/inbox.ts",
  "packages/client/project-projection.ts",
  "packages/client/request-attention.ts",
]);
const urgencyConsumers = new Set([
  "core/features/navigation-default.ts",
]);
function crossedOwners(path: string, text: string): string[] {
  if (path === "packages/protocol/inbox.ts") return [];
  const symbols = new Set(
    new Source(text).all.flatMap((node) =>
      node.type === "Identifier"
        ? [node.name]
        : node.type === "StringLiteral"
        ? [node.value]
        : []
    ),
  );
  return [
    ...["attentionStatus", "PROJECT_STATUS_PRIORITY", "INBOX_STATUS_PRIORITY"]
      .filter((name) => symbols.has(name)),
    ...["ROLLUP_PRIORITY", "rollupStatus"].filter((name) =>
      symbols.has(name) && !lampConsumers.has(path)
    ),
    ...["URGENCY_PRIORITY", "urgentStatus"].filter((name) =>
      symbols.has(name) && !urgencyConsumers.has(path)
    ),
  ];
}
Deno.test("lamp consumers cannot borrow urgency and navigation or notifications cannot borrow lamp display", async () => {
  const violations: string[] = [];
  for (const [path, text] of await productionSources()) {
    if (!/\.tsx?$/.test(path)) continue;
    for (const symbol of crossedOwners(path, text)) {
      violations.push(`${path}: ${symbol}`);
    }
  }
  assertEquals(violations, []);
});
Deno.test("priority boundary catches renamed imports, namespace access and ambiguous legacy aliases", () => {
  assertEquals(
    crossedOwners(
      "core/features/navigation-default.ts",
      'import {rollupStatus as pick} from "@otk/protocol";',
    ),
    ["rollupStatus"],
  );
  assertEquals(
    crossedOwners(
      "packages/client/notification-triggers.ts",
      'import * as p from "@otk/protocol"; p["ROLLUP_PRIORITY"];',
    ),
    ["ROLLUP_PRIORITY"],
  );
  assertEquals(
    crossedOwners(
      "packages/client/tabs.ts",
      'import {urgentStatus as lamp} from "@otk/protocol";',
    ),
    ["urgentStatus"],
  );
  assertEquals(
    crossedOwners(
      "packages/client/inbox.ts",
      'export {rollupStatus as attentionStatus} from "@otk/protocol";',
    ),
    ["attentionStatus"],
  );
});
