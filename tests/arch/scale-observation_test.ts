// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals } from "@std/assert";
import { nodes, parse, property } from "./syntax.ts";

/** Convergence and comparison of mutable owners must share an observation. */
function observationGaps(text: string): number {
  const all = [...nodes(parse(text))];
  const comparesWire = (node: Parameters<typeof nodes>[0]) => {
    const body = [...nodes(node)];
    return body.some((part) =>
      part.type === "CallExpression" && property(part.callee) === "entry"
    ) && body.some((part) =>
      part.type === "CallExpression" && property(part.callee) === "scoped"
    );
  };
  const convergence = all.filter((node) =>
    node.type === "AwaitExpression" &&
    node.argument.type === "CallExpression" &&
    property(node.argument.callee) === "waitFor" && comparesWire(node)
  );
  const comparisons = all.filter((node) =>
    node.type === "ForOfStatement" && comparesWire(node)
  );
  assertEquals(convergence.length, 1, "Identify the wire convergence wait");
  assertEquals(comparisons.length, 1, "Identify the final wire/totals loop");
  const begin = convergence[0].end!, end = comparisons[0].end!;
  assert(begin <= comparisons[0].start!);
  return all.filter((node) =>
    node.type === "AwaitExpression" && node.start! >= begin && node.end! <= end
  ).length;
}

const fixture = (gap: string, inside = "") =>
  `async function scale() {
  resources().evidence("samples", async () => await exportSamples());
  await waitFor(() => requested.filter(row => !equal(client.entry(row.id), scoped(row.id))), behind => behind.length === 0);
  ${gap}
  for (const row of requested) {
    ${inside}
    assertEquals(client.entry(row.id), scoped(row.id));
    assertEquals(index.get(row.id).calls, row.expected.calls);
  }
  await exportSamples();
}`;

Deno.test("scale observation guard distinguishes export gaps from later evidence", () => {
  assertEquals(observationGaps(fixture("await exportSamples();")), 1);
  assertEquals(observationGaps(fixture("", "await exportSamples();")), 1);
  assertEquals(observationGaps(fixture("console.info(samples);")), 0);
});

Deno.test("scale wire convergence and final totals have no asynchronous gap", async () => {
  const source = await Deno.readTextFile(
    "tests/integration/scale/session-scale_test.ts",
  );
  assertEquals(
    observationGaps(source),
    0,
    "Export evidence only after comparisons",
  );
});
