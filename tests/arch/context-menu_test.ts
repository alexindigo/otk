// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals } from "@std/assert";
import { Source, uiSources } from "./analysis.ts";
import { contextBypasses } from "./bypasses.ts";
import type { t } from "./syntax.ts";
contextBypasses((source) => errors("components/New.tsx", source));

/** A generic native binder may handle dynamic names only when that exact,
 * immutable loop name has already rejected the reserved contextmenu event. */
function excludesContextMenu(
  parsed: Source,
  call: t.CallExpression | t.OptionalCallExpression,
) {
  const name = parsed.access(call.arguments[0]);
  if (!name || name.fields.length) return false;
  let current: t.Node | undefined = call;
  while (current && current.type !== "ForOfStatement") {
    if (current.type === "TryStatement") return false;
    current = parsed.parent.get(current);
  }
  if (
    current?.type !== "ForOfStatement" ||
    current.body.type !== "BlockStatement" || name.binding.scope !== current
  ) return false;
  const body = current.body;
  let statement: t.Node = call;
  while (
    parsed.parent.get(statement) && parsed.parent.get(statement) !== body
  ) statement = parsed.parent.get(statement)!;
  const position = body.body.indexOf(statement as t.Statement);
  return position >= 0 && body.body.slice(0, position).some((statement) => {
    if (
      statement.type !== "IfStatement" ||
      statement.test.type !== "BinaryExpression" ||
      statement.test.operator !== "==="
    ) return false;
    const { left, right } = statement.test;
    const variable = parsed.string(left) === "contextmenu"
      ? right
      : parsed.string(right) === "contextmenu"
      ? left
      : undefined;
    const tested = parsed.access(variable);
    if (tested?.binding !== name.binding || tested.fields.length) return false;
    const branch = statement.consequent;
    return branch.type === "ThrowStatement" ||
      branch.type === "BlockStatement" && branch.body.length === 1 &&
        branch.body[0].type === "ThrowStatement";
  });
}

export function errors(name: string, source: string): string[] {
  const errors: string[] = [];
  let parsed: Source;
  try {
    parsed = new Source(source);
  } catch {
    return ["context source must parse"];
  }
  const owner =
    name.replace(/^packages\/ui\//, "") === "components/ContextMenu.tsx";
  for (const node of parsed.all) {
    if (
      (node.type === "CallExpression" ||
        node.type === "OptionalCallExpression") &&
      ["addEventListener", "removeEventListener"].includes(
        parsed.name(node.callee)?.split(".").at(-1) ?? "",
      )
    ) {
      const event = parsed.string(node.arguments[0]);
      if (
        !owner &&
        (event === "contextmenu" ||
          event === undefined && !excludesContextMenu(parsed, node))
      ) {
        errors.push("contextmenu listener belongs to ContextMenu");
      }
    }
    if (node.type === "JSXAttribute") {
      const name = node.name.type === "JSXIdentifier" ? node.name.name : "";
      if (
        /^oncontextmenu$/i.test(name) ||
        /^data-context-(?:kind|target)$/.test(name)
      ) errors.push("targets use the shared contextTarget binding");
    }
    if (
      node.type === "JSXSpreadAttribute" &&
      (node.argument.type === "CallExpression" ||
        node.argument.type === "OptionalCallExpression") &&
      parsed.name(node.argument.callee) === "contextTarget"
    ) errors.push("contextTarget is a composable callback ref");
  }
  if (
    !owner && parsed.all.some((node) =>
      (node.type === "MemberExpression" ||
        node.type === "OptionalMemberExpression") &&
      parsed.name(node)?.endsWith(".key")
    ) &&
    parsed.all.some((node) =>
      ["ContextMenu", "F10"].includes(parsed.string(node) ?? "")
    )
  ) errors.push("context-menu keyboard opening belongs to ContextMenu");
  return errors;
}
Deno.test("context menus have one shell-root listener owner and declarative target bindings", async () => {
  const ui = new URL("../../packages/ui/", import.meta.url);
  for (const [path, source] of await uiSources()) {
    if (!path.endsWith(".css")) assertEquals(errors(path, source), [], path);
  }
  const owner = await Deno.readTextFile(
    new URL("components/ContextMenu.tsx", ui),
  );
  const parsed = new Source(owner);
  const listeners = parsed.calls("addEventListener").filter((node) =>
    parsed.string(node.arguments[0]) === "contextmenu"
  );
  assertEquals(listeners.length, 1);
  assert(
    parsed.name(listeners[0].callee) === "props.root.addEventListener" &&
      parsed.name(listeners[0].arguments[1]) === "pointer" &&
      listeners[0].arguments[2]?.type === "BooleanLiteral" &&
      listeners[0].arguments[2].value,
  );
  assert(parsed.calls("contextTargets").length > 0);
  assert(
    parsed.all.some((node) =>
      node.type === "JSXOpeningElement" &&
      parsed.name(node.name) === "CommandMenu"
    ),
  );
  for (
    const source of [
      "<div onContextMenu={() => {}} />",
      'el.addEventListener("contextmenu", handler)',
      "el.addEventListener(`contextmenu`, handler)",
      "if (event.key === `ContextMenu`) open()",
      'if (event.shiftKey && event.key === "F10") open()',
      'if (["ContextMenu", "F10"].includes(event.key)) open()',
      '<div data-context-kind="session"/>',
      "<div {...contextTarget(() => target)} />",
    ]
  ) {
    assert(errors("components/Other.tsx", source).length, source);
    assert(errors("web/src/ui/Other.tsx", source).length, source);
  }
});

Deno.test("generic native listeners must reject contextmenu before binding the same immutable name", () => {
  const guarded =
    `for (const name of names) { if (name === 'contextmenu') throw new TypeError(); el.addEventListener(name, handler); cleanup.push(()=>el.removeEventListener(name,handler)); }`;
  assertEquals(errors("components/native-attributes.ts", guarded), []);
  for (
    const mutant of [
      guarded.replace("name === 'contextmenu'", "other === 'contextmenu'"),
      guarded.replace("throw new TypeError()", "ignore()"),
      guarded.replace("if (name === 'contextmenu') throw new TypeError();", ""),
      `for (let name of names) { if(name==='contextmenu')throw new Error(); name=other; el.addEventListener(name,handler); }`,
      `for (const name of names) { el.addEventListener(name,handler); if(name==='contextmenu')throw new Error(); }`,
      `for (const name of names) { try { if(name==='contextmenu')throw new Error(); } catch {} el.addEventListener(name,handler); }`,
    ]
  ) {
    assert(
      errors("components/native-attributes.ts", mutant).length > 0,
      mutant,
    );
  }
});

Deno.test("transcript views declare targets and state ports while one feature owns context contributions", async () => {
  const ui = new URL("../../packages/ui/", import.meta.url);
  for (
    const name of ["Message", "Code", "Diff", "TurnUsage", "tools/ToolFrame"]
  ) {
    const source = await Deno.readTextFile(
      new URL(`components/${name}.tsx`, ui),
    );
    assert(
      !/\bcontext\s*:/.test(source),
      `${name}: context commands belong to the transcript feature`,
    );
  }
  const feature = await Deno.readTextFile(
    new URL("features/transcript-context.tsx", ui),
  );
  assert(feature.includes("ownedCommand(ports"));
  assert(!feature.includes("randomUUID"));
});
