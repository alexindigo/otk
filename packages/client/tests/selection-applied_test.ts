// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals, assertObjectMatch } from "@std/assert";
import {
  chooseVariant,
  effectiveSelection,
  emptyDraft,
  type PromptSelectionContext,
} from "../mod.ts";

const model = { provider: "fixture", model: "reasoning" };
const context: PromptSelectionContext = {
  agents: [{ name: "build", model, variant: "high" }],
  catalog: {
    default: model,
    providers: [{
      id: "fixture",
      name: "Fixture",
      models: [{
        id: "reasoning",
        name: "Reasoning",
        variants: ["low", "high"],
        status: "active",
        free: false,
      }],
    }],
  },
};

Deno.test("Default projects the agent-applied variant without sending a user variant", () => {
  const result = effectiveSelection(
    { ...emptyDraft(), variant: undefined },
    context,
  );
  assertEquals(result.variant.value, "high");
  assertObjectMatch(result.variant, {
    source: "configured",
    userChosen: false,
  });
  assertEquals(result.input.variant, undefined);
  assertObjectMatch(result, { variantChoice: undefined });
});

Deno.test("selection ownership follows each applied source, including restored user choices", () => {
  const explicit = effectiveSelection({
    ...emptyDraft(),
    agent: "build",
    model,
    variant: "low",
  }, context);
  const restored = effectiveSelection(emptyDraft(), {
    ...context,
    context: { agent: "build", model, variant: "low" },
  });
  for (
    const [result, source] of [[explicit, "explicit"], [
      restored,
      "restored",
    ]] as const
  ) {
    for (const field of [result.agent, result.model, result.variant]) {
      assertEquals(field.source, source);
      assertEquals(field.userChosen, true);
    }
    assertEquals(result.variantChoice, "low");
    assertEquals(result.input.variant, "low");
  }
  const configured = effectiveSelection(emptyDraft(), context);
  for (
    const field of [configured.agent, configured.model, configured.variant]
  ) {
    assertEquals(field.source, "configured");
    assertEquals(field.userChosen, false);
  }
  const fallback = effectiveSelection(emptyDraft(), { ...context, agents: [] });
  assertObjectMatch(fallback.model, {
    value: model,
    source: "default",
    userChosen: false,
  });
  for (const field of [fallback.agent, fallback.variant]) {
    assertEquals(field.source, "absent");
    assertEquals(field.userChosen, false);
  }
});

Deno.test("native variant fallback requires agent model identity and advertised membership", () => {
  for (
    const agents of [
      [{ name: "build", variant: "high" }],
      [{
        name: "build",
        model: { ...model, provider: "other" },
        variant: "high",
      }],
      [{ name: "build", model: { ...model, model: "other" }, variant: "high" }],
      [{ name: "build", model, variant: "missing" }],
    ]
  ) {
    for (
      const draft of [
        { ...emptyDraft(), model },
        { ...emptyDraft(), model, variant: undefined },
      ]
    ) {
      const result = effectiveSelection(draft, { ...context, agents });
      assertEquals(result.variant.value, undefined);
      assertEquals(result.input.variant, undefined);
    }
  }
  for (const variant of [undefined, "invalid"]) {
    const result = effectiveSelection({ ...emptyDraft(), variant }, context);
    assertObjectMatch(result.variant, {
      value: "high",
      source: "configured",
      userChosen: false,
    });
    assertEquals(result.input.variant, undefined);
    assertEquals(result.variantChoice, undefined);
  }
});

Deno.test("shell omits applied variants and preserves the normal choice across every source", () => {
  for (const variant of [undefined, "low"]) {
    const draft = chooseVariant(emptyDraft(), variant, context);
    const normal = effectiveSelection(draft, context);
    const shell = effectiveSelection({ ...draft, mode: "shell" }, context);
    assertEquals(shell.applies.variant, false);
    assertEquals(shell.variant, { source: "absent", userChosen: false });
    assertEquals(Object.hasOwn(shell.input, "variant"), false);
    assertEquals(shell.variantChoice, undefined);
    assertEquals(shell.agent, normal.agent);
    assertEquals(shell.model, normal.model);
    assertEquals(effectiveSelection(draft, context), normal);
  }
  for (const extra of [{}, { context: { model, variant: "low" } }]) {
    const result = effectiveSelection({ ...emptyDraft(), mode: "shell" }, {
      ...context,
      ...extra,
    });
    assertEquals(result.variant, { source: "absent", userChosen: false });
    assertEquals(Object.hasOwn(result.input, "variant"), false);
  }
});
