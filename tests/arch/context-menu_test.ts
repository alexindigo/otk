// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals } from "@std/assert";
import { Source, uiSources } from "./analysis.ts";
import { contextBypasses } from "./bypasses.ts";
contextBypasses((source) => errors("components/New.tsx", source));

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
      if (!owner && (event === "contextmenu" || event === undefined)) {
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
