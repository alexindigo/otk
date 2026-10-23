// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals, assertNotEquals } from "@std/assert";
import { Source } from "./analysis.ts";
import { Graph } from "./graph.ts";

for (
  const [name, text] of [
    ["reassignment", 'let label = "safe"; label = input; consume(label);'],
    ["update", 'let label = "safe"; label++; consume(label);'],
    [
      "catch shadow",
      'const label = "safe"; try {} catch (label) { consume(label); }',
    ],
    [
      "function var shadow",
      'const label = "safe"; function render() { if (flag) { var label = input; } consume(label); }',
    ],
    [
      "class shadow",
      'const label = "safe"; function render() { class label {} consume(label); }',
    ],
  ]
) {
  Deno.test(`A12 binding provenance cannot reuse an initializer after ${name}`, () => {
    const source = new Source(text);
    const call = source.calls("consume")[0];
    assertNotEquals(source.string(call.arguments[0]), "safe");
  });
}

Deno.test("A12 component graph resolves the lexical use rather than an outer import", () => {
  const graph = new Graph(
    new Map([
      [
        "Host.tsx",
        'import { Content } from "./Content.tsx"; function Host(Content) { return <Content />; }',
      ],
      ["Content.tsx", "export function Content() { return <div />; }"],
    ]),
  );
  const source = graph.sources.get("Host.tsx")!;
  const opening = source.all.find((node) => node.type === "JSXOpeningElement")!;
  if (opening.type !== "JSXOpeningElement") {
    throw new Error("missing fixture JSX");
  }
  assertEquals(graph.component("Host.tsx", opening.name), undefined);
});

Deno.test("A12 component graph requires the requested export, not a TSX filename or body identifier", () => {
  const graph = new Graph(
    new Map([
      ["Content.tsx", "export function Other() { return Content; }"],
    ]),
  );
  assertEquals(graph.exported("Content.tsx", "Content"), undefined);
});

Deno.test("A12 accepts immutable import aliases, namespace members and destructured accesses", () => {
  const source = new Source(`
    import { relativeTarget as present } from "./paths.ts";
    import * as paths from "./paths.ts";
    import Label from "./ToolPath.tsx";
    const format = present;
    const {relativeTarget: viaNamespace} = paths;
    consume(format, viaNamespace, Label);
  `);
  const args = source.calls("consume")[0].arguments;
  assertEquals(args.map((arg) => source.imported(arg)), [
    { module: "./paths.ts", name: "relativeTarget" },
    { module: "./paths.ts", name: "relativeTarget" },
    { module: "./ToolPath.tsx", name: "default" },
  ]);
});

Deno.test("A12 accepts lexical block and loop boundaries without leaking local bindings", () => {
  const source = new Source(`
    const label = "outer";
    for (const label of labels) { consume(label); }
    { const label = "block"; consume(label); }
    const object = { method(label) { consume(label); } };
    consume(label);
  `);
  assertEquals(
    source.calls("consume").map((call) => source.string(call.arguments[0])),
    [
      undefined,
      "block",
      undefined,
      "outer",
    ],
  );
});

Deno.test("A12 accepts named, namespace, default and aliased barrel component exports", () => {
  const graph = new Graph(
    new Map([
      [
        "Host.tsx",
        `import Default from "./barrel.ts";
      import { Content as Named } from "./barrel.ts";
      import * as All from "./barrel.ts";
      const Alias = Named;
      function Host() { return <><Default /><Named /><All.Content /><Alias /></>; }`,
      ],
      [
        "barrel.ts",
        'export { Content, Content as default } from "./Content.tsx";',
      ],
      ["Content.tsx", "export function Content() { return <div />; }"],
    ]),
  );
  const source = graph.sources.get("Host.tsx")!;
  assertEquals(
    source.all.filter((n) => n.type === "JSXOpeningElement").map((n) =>
      n.type === "JSXOpeningElement" && graph.component("Host.tsx", n.name)
    ),
    ["Content.tsx", "Content.tsx", "Content.tsx", "Content.tsx"],
  );
});
