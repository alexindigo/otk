// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals } from "@std/assert";
import { Source, uiSources } from "./analysis.ts";
import { nodes } from "./syntax.ts";
import { pickerErrors } from "./picker-policy.ts";
import { pickerBypasses, readinessBypasses } from "./bypasses.ts";
pickerBypasses((source) =>
  errors("packages/ui/features/prompt/nested/extension.tsx", source)
);
readinessBypasses(readinessErrors);
const root = new URL("../../", import.meta.url);
export function errors(path: string, source: string): string[] {
  return pickerErrors(path, source);
}
/** Row owners must be destroyed, not merely hidden, when the picker closes. */
export function lifetimeErrors(text: string): string[] {
  const source = new Source(text);
  const owners = source.all.filter((node) =>
    node.type === "JSXOpeningElement" &&
    ["VirtualList", "For"].includes(source.name(node.name) ?? "")
  );
  if (!owners.length) return ["picker requires a row owner"];
  return owners.flatMap((owner) => {
    let current = source.parent.get(owner);
    while (current) {
      if (
        current.type === "JSXElement" &&
        source.name(current.openingElement.name) === "Show" &&
        owner.start! >= current.openingElement.end!
      ) {
        const when = source.value(source.attr(current.openingElement, "when"));
        if (
          when?.type === "CallExpression" &&
          source.name(when.callee) === "opened" && !when.arguments.length
        ) return [];
      }
      current = source.parent.get(current);
    }
    return ["picker row owner remains mounted after close"];
  });
}
export function readinessErrors(source: string): string[] {
  const parsed = new Source(source);
  const bodies = parsed.all.flatMap((node) => {
    if (node.type === "FunctionDeclaration" && node.id?.name === "submit") {
      return [node.body];
    }
    if (
      node.type === "VariableDeclarator" && node.id.type === "Identifier" &&
      node.id.name === "submit" &&
      node.init?.type === "ArrowFunctionExpression" &&
      node.init.body.type === "BlockStatement"
    ) return [node.init.body];
    return [];
  });
  if (bodies.length !== 1) return ["submission requires one unambiguous owner"];
  let ready = false, read = false;
  for (const statement of bodies[0].body) {
    if (
      statement.type === "ExpressionStatement" &&
      statement.expression.type === "AwaitExpression"
    ) {
      const call = statement.expression.argument;
      if (
        (call.type === "CallExpression" ||
          call.type === "OptionalCallExpression") &&
        parsed.name(call.callee)?.endsWith(".ready")
      ) ready = true;
    }
    if (
      [...nodes(statement)].some((node) =>
        node.type === "CallExpression" && parsed.name(node.callee) === "change"
      )
    ) {
      if (!ready) {
        return ["submission must await readiness before reading its draft"];
      }
      read = true;
    }
  }
  return ready && read
    ? []
    : ["submission must await readiness before reading its draft"];
}
Deno.test("ListPicker uses shared owners and prompt selection flows through one contributed projection", async () => {
  for (const [path, source] of await uiSources()) {
    if (!path.endsWith(".css")) assertEquals(errors(path, source), [], path);
  }
  for (
    const invalid of [
      "ctx.rpc('models.list')",
      "prefs.models",
      "element.parentElement",
      "document.querySelector('.prompt')",
    ]
  ) {
    assert(
      errors(
        "ListPicker.tsx",
        `<Popover><SelectionContent {...selection({})} />${invalid}`,
      ).length,
    );
  }
  assert(errors("Prompt.tsx", 'ctx.rpc("models.list", input)').length);
  assert(
    errors(
      "packages/ui/features/prompt/catalog.ts",
      'part.name === "plan_exit"',
    ).length,
  );
  assert(
    errors("packages/ui/shell/Shell.tsx", 'part.name === "plan_enter"').length,
  );
  assert(
    errors(
      "Prompt.tsx",
      "const context = { nextSelection: (draft = change((value) => value)) => draft };",
    )
      .length,
  );
  for (
    const invalid of [
      "JSON.parse(key)",
      "modelGroups(catalog)",
      "toggleFavouriteModel(prefs, ref)",
      "let queue = Promise.resolve()",
      "chooseModel(draft, model)",
    ]
  ) assert(errors("features/prompt/agents.tsx", invalid).length);
  assert(
    errors("features/prompt/catalog.ts", "let pending = load().then(apply)")
      .length,
  );
  const prompt = await Deno.readTextFile(
    new URL("packages/ui/components/Prompt.tsx", root),
  );
  assert(prompt.includes("feature.submit?.(draft, parts, selection)"));
  assert(prompt.includes("send({ parts, mode: draft.mode, selection })"));
  assertEquals(readinessErrors(prompt), []);
  const picker = await Deno.readTextFile(
    new URL("packages/ui/components/ListPicker.tsx", root),
  );
  assertEquals(lifetimeErrors(picker), []);
  assert(
    !picker.includes('"★"') && !picker.includes('"☆"'),
    "Generic actions inject their own content",
  );
});

Deno.test("picker row ownership rejects retained closed windows", () => {
  for (const owner of ["VirtualList", "For"]) {
    assertEquals(
      lifetimeErrors(`<Show when={opened()}><${owner} /></Show>`),
      [],
    );
    for (
      const invalid of [
        `<div hidden={!opened()}><${owner} /></div>`,
        `<><Show when={opened()} /><${owner} /></>`,
        `<Show when={true}><${owner} /></Show>`,
        `<Show when={opened()} fallback={<${owner} />}><span /></Show>`,
      ]
    ) assert(lifetimeErrors(invalid).length, invalid);
  }
});

Deno.test("A12 submission readiness accepts aliased ports and formatted awaits", () => {
  assertEquals(
    readinessErrors(`
    const current = ctx;
    async function submit() {
      await current["ready"](/* wait for the owning resource */);
      const readDraft = change;
      const value = readDraft(item => item);
      return value;
    }
  `),
    [],
  );
});
