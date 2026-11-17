// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals } from "@std/assert";
import { Source } from "./analysis.ts";
import { property } from "./syntax.ts";

function hiddenPrimary(text: string): string[] {
  const source = new Source(text);
  const errors: string[] = [];
  for (const node of source.all) {
    if (
      node.type !== "JSXElement" ||
      property(node.openingElement.name) !== "PrimaryAction"
    ) continue;
    for (
      let parent = source.parent.get(node);
      parent;
      parent = source.parent.get(parent)
    ) {
      if (
        parent.type === "ConditionalExpression" ||
        parent.type === "LogicalExpression" ||
        (parent.type === "JSXElement" &&
          property(parent.openingElement.name) === "Show")
      ) {
        errors.push("PrimaryAction cannot be conditionally mounted");
      }
      if (
        parent.type === "ArrowFunctionExpression" ||
        parent.type === "FunctionExpression" ||
        parent.type === "FunctionDeclaration"
      ) {
        const expression = source.parent.get(parent);
        // JSX child render callbacks inherit their enclosing mount condition;
        // a component or an injected actions callback owns a separate boundary.
        if (
          expression?.type !== "JSXExpressionContainer" ||
          source.parent.get(expression)?.type !== "JSXElement"
        ) break;
      }
    }
  }
  return errors;
}

Deno.test("primary action architecture rejects conditional existence, including pending and capability guards", () => {
  for (
    const condition of [
      "!pending()",
      "canSubmit()",
      "hasDraftContent(draft)",
      "connected()",
    ]
  ) {
    assert(
      hiddenPrimary(`<Show when={${condition}}><PrimaryAction /></Show>`)
        .length > 0,
    );
    assert(
      hiddenPrimary(`const view = ${condition} && <PrimaryAction />;`).length >
        0,
    );
    assert(
      hiddenPrimary(`const view = ${condition} ? <PrimaryAction /> : null;`)
        .length > 0,
    );
  }
  assertEquals(
    hiddenPrimary("const view = <div><PrimaryAction state={state()} /></div>"),
    [],
  );
});

Deno.test("primary action audit follows nested JSX child render callbacks without crossing component or action boundaries", () => {
  for (
    const text of [
      "<Show when={ready()}>{() => <PrimaryAction />}</Show>",
      "<Show when={ready()}>{() => <div>{() => <PrimaryAction />}</div>}</Show>",
      "<Show when={ready()}>{function render() { return <PrimaryAction />; }}</Show>",
      "const view = ready() && <Content>{() => <PrimaryAction />}</Content>;",
    ]
  ) assert(hiddenPrimary(text).length > 0, text);
  for (
    const text of [
      "const View = () => <div>{() => <PrimaryAction />}</div>;",
      "function View() { return <Content>{() => <PrimaryAction />}</Content>; }",
      "<Show when={ready()}><Content actions={() => <PrimaryAction />} /></Show>",
      "const build = () => <PrimaryAction />; const view = ready() && build;",
    ]
  ) assertEquals(hiddenPrimary(text), [], text);
});

Deno.test("Prompt and takeovers use the persistent shared primary control and owner", async () => {
  for (const name of ["Prompt", "QuestionDock", "PermissionDock", "FormDock"]) {
    const text = await Deno.readTextFile(`packages/ui/components/${name}.tsx`);
    assert(text.includes("createPrimaryAction"), name);
    assert(text.includes("<PrimaryAction"), name);
    assertEquals(hiddenPrimary(text), [], name);
  }
  const text = await Deno.readTextFile(
    "packages/ui/components/PrimaryAction.tsx",
  );
  assert(text.includes("disabled={!props.state.available}"));
  assert(text.includes("aria-description={props.state.reason"));
  assert(!/\bhidden=|<Show\b/.test(text));
  const takeover = await Deno.readTextFile(
    "packages/ui/components/surface/Takeover.tsx",
  );
  assert(takeover.includes("actions?: () => Element"));
  assert(takeover.includes("<ContentSlot content={props.actions}"));
});
