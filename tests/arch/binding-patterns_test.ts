// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals } from "@std/assert";
import { Source } from "./analysis.ts";

for (
  const [name, text] of [
    [
      "default parameter",
      'import { safe } from "./owner.ts"; function f(value = safe) { consume(value); }',
    ],
    [
      "destructured default",
      'import * as owner from "./owner.ts"; const { safe: value = impostor } = owner; consume(value);',
    ],
    [
      "rest parameter shadow",
      'import { safe } from "./owner.ts"; function f(...safe) { consume(safe); }',
    ],
    [
      "object rest shadow",
      'import { safe } from "./owner.ts"; function f({ ...safe }) { consume(safe); }',
    ],
    [
      "array rest shadow",
      'import { safe } from "./owner.ts"; function f([ ...safe ]) { consume(safe); }',
    ],
    [
      "unknown computed key",
      'import * as owner from "./owner.ts"; const { [safe]: value } = owner; consume(value);',
    ],
    [
      "mutated computed key",
      'import * as owner from "./owner.ts"; let key = "safe"; key = input; const { [key]: value } = owner; consume(value);',
    ],
    [
      "computed key before initialization",
      'import * as owner from "./owner.ts"; const { [key]: value } = owner; const key = "safe"; consume(value);',
    ],
    [
      "alias before initialization",
      'import { safe } from "./owner.ts"; consume(value); const value = safe;',
    ],
    [
      "self initializer",
      'import { safe } from "./owner.ts"; const value = (consume(value), safe);',
    ],
  ]
) {
  Deno.test(`B8 lexical provenance rejects ${name}`, () => {
    const source = new Source(text);
    assertEquals(
      source.imported(source.calls("consume")[0].arguments[0]),
      undefined,
    );
  });
}

Deno.test("B8 lexical values reject conditional defaults and use before initialization", () => {
  for (
    const text of [
      'function f(value = "safe") { consume(value); }',
      'consume(value); const value = "safe";',
      'consume(value); var value = "safe";',
    ]
  ) {
    const source = new Source(text);
    assertEquals(
      source.string(source.calls("consume")[0].arguments[0]),
      undefined,
    );
  }
});

Deno.test("B8 lexical provenance accepts resolved computed keys without splitting property identity", () => {
  const source = new Source(`
    import * as owner from "./owner.ts";
    const key = "safe";
    const { [key]: first, ["a.b"]: second } = owner;
    consume(first, second);
  `);
  assertEquals(
    source.calls("consume")[0].arguments.map((arg) => source.imported(arg)),
    [
      { module: "./owner.ts", name: "safe" },
      { module: "./owner.ts", name: "a.b" },
    ],
  );
});
