// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals } from "@std/assert";
import * as css from "css-tree";
import { Source } from "./analysis.ts";
import { property, type t } from "./syntax.ts";

async function component(path: string) {
  return new Source(
    await Deno.readTextFile(
      new URL(`../../packages/ui/${path}`, import.meta.url),
    ),
    path,
  );
}

function timers(source: Source, milliseconds: number) {
  return source.all.filter((node): node is t.CallExpression =>
    node.type === "CallExpression" && property(node.callee) === "setTimeout" &&
    source.value(node.arguments[1])?.type === "NumericLiteral" &&
    (source.value(node.arguments[1]) as t.NumericLiteral).value === milliseconds
  );
}

/** The owner may rename its policy; callers must resolve to the same immutable
 * declaration, rather than merely happen to contain equal numbers today. */
function duration(source: Source, uses: (t.Node | null | undefined)[]) {
  const declarations = uses.map((use) => {
    assert(
      use?.type === "Identifier",
      "Interaction duration is a copied literal",
    );
    const binding = source.binding(use.name, use);
    assert(binding?.value && !binding.written, "Duration must be immutable");
    const declaration = source.parent.get(binding.value);
    assert(declaration?.type === "VariableDeclarator");
    const statement = source.parent.get(declaration);
    assert(
      statement?.type === "VariableDeclaration" && statement.kind === "const",
    );
    return declaration;
  });
  assert(declarations.length > 1);
  assert(
    declarations.every((node) => node === declarations[0]),
    "Duration has multiple owners",
  );
}

Deno.test("lamp animation and pulse lifetime consume the same component duration", async () => {
  const source = await component("components/StatusLight.tsx");
  const pulse = timers(source, 250);
  assertEquals(pulse.length, 1);
  const paint = source.all.find((node) =>
    node.type === "ObjectProperty" &&
    property(node.key) === "--lamp-blink-duration"
  );
  assert(paint?.type === "ObjectProperty", "Lamp duration does not reach CSS");
  assert(paint.value.type === "TemplateLiteral");
  assertEquals(paint.value.quasis.map((part) => part.value.cooked), ["", "ms"]);
  duration(source, [pulse[0].arguments[1], ...paint.value.expressions]);
  const sheet = css.parse(
    await Deno.readTextFile(
      new URL("../../packages/ui/components/StatusLight.css", import.meta.url),
    ),
  );
  const animations: string[] = [];
  css.walk(sheet, (node) => {
    if (
      node.type !== "Rule" || !node.prelude ||
      !css.generate(node.prelude).includes("[data-blink]")
    ) return;
    css.walk(node.block, (child) => {
      if (child.type === "Declaration" && child.property === "animation") {
        animations.push(css.generate(child.value));
      }
    });
  });
  assertEquals(animations, [
    "otk-lamp-blink var(--lamp-blink-duration) linear",
  ]);
});

Deno.test("interrupt admission deadline and disarming timer share one owner policy", async () => {
  const source = await component("components/Prompt.tsx");
  const disarm = timers(source, 5000);
  assertEquals(disarm.length, 1);
  const deadline = source.all.filter((node): node is t.BinaryExpression =>
    node.type === "BinaryExpression" && node.operator === "+" &&
    node.left.type === "CallExpression" &&
    property(node.left.callee) === "now" &&
    source.value(node.right)?.type === "NumericLiteral" &&
    (source.value(node.right) as t.NumericLiteral).value === 5000
  );
  assertEquals(deadline.length, 1);
  duration(source, [disarm[0].arguments[1], deadline[0].right]);
});

Deno.test("preview exits from trigger and panel share their component delay", async () => {
  const source = await component("components/surface/Popover.tsx");
  const exits = source.all.filter((node): node is t.JSXAttribute =>
    node.type === "JSXAttribute" && node.name.type === "JSXIdentifier" &&
    node.name.name === "onMouseLeave"
  );
  assertEquals(exits.length, 2);
  duration(
    source,
    exits.map((node) =>
      node.value?.type === "JSXExpressionContainer"
        ? node.value.expression
        : null
    ),
  );
  const sheet = css.parse(
    await Deno.readTextFile(
      new URL(
        "../../packages/ui/components/surface/Popover.css",
        import.meta.url,
      ),
    ),
  );
  const policy: Record<string, string[]> = {};
  css.walk(sheet, (node) => {
    if (
      node.type === "Declaration" &&
      ["--hover-open-delay", "--hover-close-delay"].includes(node.property)
    ) (policy[node.property] ??= []).push(css.generate(node.value).trim());
  });
  assertEquals(policy, {
    "--hover-open-delay": ["500ms"],
    "--hover-close-delay": ["150ms"],
  });
  for (const token of Object.keys(policy)) {
    assertEquals(
      source.all.filter((node) =>
        node.type === "CallExpression" && property(node.callee) === "delay" &&
        node.arguments[0]?.type === "StringLiteral" &&
        node.arguments[0].value === token
      ).length,
      1,
      `${token} is read once by its shared owner`,
    );
  }
});
