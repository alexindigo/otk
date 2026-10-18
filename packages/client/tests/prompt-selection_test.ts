// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals, assertStrictEquals } from "@std/assert";
import type { ModelCatalog, ModelRef } from "@otk/protocol";
import {
  chooseAgent,
  chooseModel,
  chooseVariant,
  clearDraft,
  createDrafts,
  effectiveSelection,
  emptyDraft,
  type PromptSelectionContext,
} from "../mod.ts";

const first: ModelRef = { provider: "one", model: "shared" };
const second: ModelRef = { provider: "two", model: "shared" };
const plain: ModelRef = { provider: "two", model: "plain" };
const catalog: ModelCatalog = {
  providers: [
    {
      id: "one",
      name: "First provider",
      models: [{
        id: "shared",
        name: "First model",
        variants: ["low", "high"],
        status: "active",
        free: false,
      }],
    },
    {
      id: "two",
      name: "Second provider",
      models: [
        {
          id: "shared",
          name: "Second model",
          variants: ["medium", "high"],
          status: "active",
          free: false,
        },
        {
          id: "plain",
          name: "Plain model",
          variants: [],
          status: "beta",
          free: false,
        },
      ],
    },
  ],
  default: plain,
};
const context: PromptSelectionContext = {
  agents: [
    { name: "build", color: "#aabbcc", model: first, variant: "low" },
    { name: "plan", model: second, variant: "medium" },
    { name: "review" },
  ],
  catalog,
};

Deno.test("selection resolves explicit, restored, agent-configured, catalog-default and absent choices in order", () => {
  const restored = {
    ...context,
    context: { agent: "plan", model: second, variant: "medium" },
  };
  const draft = {
    ...emptyDraft(),
    agent: "build",
    model: first,
    variant: "high",
  };
  const before = structuredClone({ draft, restored });
  const explicit = effectiveSelection(draft, restored);
  assertEquals(explicit.agent, {
    value: "build",
    source: "explicit",
    color: "#aabbcc",
  });
  assertEquals(explicit.model, {
    value: first,
    source: "explicit",
    name: "First model",
    providerName: "First provider",
    variants: ["low", "high"],
    unavailable: false,
  });
  assertEquals(explicit.variant, { value: "high", source: "explicit" });
  const fromMessage = effectiveSelection(emptyDraft(), restored);
  assertEquals(fromMessage.agent.value, "plan");
  assertEquals(fromMessage.agent.source, "restored");
  assertEquals(fromMessage.model.value, second);
  assertEquals(fromMessage.model.source, "restored");
  assertEquals(fromMessage.variant, { value: "medium", source: "restored" });
  const configured = effectiveSelection(emptyDraft(), context);
  assertEquals(configured.agent.source, "configured");
  assertEquals(configured.agent.value, "build");
  assertEquals(configured.model.source, "configured");
  assertEquals(configured.model.value, first);
  assertEquals(configured.variant, { value: "low", source: "configured" });
  const fallback = effectiveSelection(
    { ...emptyDraft(), agent: "review" },
    context,
  );
  assertEquals(fallback.model.source, "default");
  assertEquals(fallback.model.value, plain);
  assertEquals(fallback.variant, { source: "absent" });
  const absent = effectiveSelection(emptyDraft(), { agents: [] });
  assertEquals(absent.agent, { source: "absent", color: undefined });
  assertEquals(absent.model, {
    source: "absent",
    name: undefined,
    providerName: undefined,
    variants: [],
    unavailable: false,
  });
  assertEquals(absent.variant, { source: "absent" });
  assertEquals({ draft, restored }, before);
});

Deno.test("selection resolves fields independently without overwriting explicit or restored model choices", () => {
  const input = {
    ...context,
    context: { agent: "plan", model: first, variant: "high" },
  };
  const draft = { ...emptyDraft(), agent: "review" };
  const result = effectiveSelection(draft, input);
  assertEquals(result.agent.value, "review");
  assertEquals(result.model, {
    value: first,
    source: "restored",
    name: "First model",
    providerName: "First provider",
    variants: ["low", "high"],
    unavailable: false,
  });
  assertEquals(result.variant, { value: "high", source: "restored" });
  assertEquals(
    effectiveSelection({ ...draft, model: second }, input).model.value,
    second,
  );
  assertEquals(
    effectiveSelection({ ...emptyDraft(), agent: "missing" }, context).agent
      .value,
    "missing",
  );
});

Deno.test("invalid variants resolve to none without falling through to a lower-precedence variant", () => {
  for (const variant of ["unknown", "medium", ""]) {
    assertEquals(
      effectiveSelection({ ...emptyDraft(), variant }, context).variant,
      { source: "absent" },
    );
  }
  assertEquals(
    effectiveSelection(emptyDraft(), {
      ...context,
      context: { model: first, variant: "unknown" },
    }).variant,
    { source: "absent" },
  );
  assertEquals(
    effectiveSelection(emptyDraft(), {
      ...context,
      agents: [{ name: "build", model: plain, variant: "high" }],
    }).variant,
    { source: "absent" },
  );
  assertEquals(
    effectiveSelection(
      { ...emptyDraft(), model: plain, variant: "high" },
      context,
    ).variant,
    { source: "absent" },
  );
});

Deno.test("unavailable explicit and restored models retain identity and display fallbacks without substitution", () => {
  const missing = { provider: "offline", model: "retired/model" };
  for (
    const result of [
      effectiveSelection(
        { ...emptyDraft(), model: missing, variant: "high" },
        context,
      ),
      effectiveSelection(emptyDraft(), {
        ...context,
        context: { model: missing, variant: "high" },
      }),
    ]
  ) {
    assertEquals(result.model.value, missing);
    assertEquals(result.model.unavailable, true);
    assertEquals(result.model.name, "retired/model");
    assertEquals(result.model.providerName, "offline");
    assertEquals(result.model.variants, []);
    assertEquals(result.variant, { source: "absent" });
  }
  const missingInProvider = effectiveSelection({
    ...emptyDraft(),
    model: { provider: "one", model: "missing" },
  }, context);
  assertEquals(missingInProvider.model.providerName, "First provider");
  assertEquals(missingInProvider.model.unavailable, true);
  const loading = effectiveSelection({ ...emptyDraft(), model: first }, {
    agents: [],
  });
  assertEquals(loading.model.value, first);
  assertEquals(loading.model.unavailable, false);
});

Deno.test("model availability is unknown without a catalog and unavailable only after negative catalog membership", () => {
  for (const explicit of [false, true]) {
    const draft = explicit ? { ...emptyDraft(), model: first } : emptyDraft();
    const input = {
      agents: [],
      context: explicit ? undefined : { model: first },
    };
    for (const catalog of [undefined, { providers: [] }]) {
      const result = effectiveSelection(draft, { ...input, catalog });
      assertEquals(result.model.value, first);
      assertEquals(result.model.unavailable, catalog !== undefined);
    }
    assertEquals(
      effectiveSelection(draft, { ...input, catalog }).model.unavailable,
      false,
    );
  }
});

Deno.test("agent intent applies configured model and variant while unconfigured agents retain draft choices", () => {
  const draft = {
    ...emptyDraft(),
    input: "Keep text",
    model: first,
    variant: "high",
  };
  const picked = chooseAgent(draft, "plan", context);
  assertEquals(picked, {
    ...draft,
    agent: "plan",
    model: second,
    variant: "medium",
  });
  assertEquals(effectiveSelection(picked, context).model.source, "explicit");
  assertEquals(chooseAgent(picked, "review", context), {
    ...picked,
    agent: "review",
  });
  assertStrictEquals(chooseAgent(draft, "unknown", context), draft);
  assertEquals(draft.model, first);
  assertEquals(draft.variant, "high");
  const modelOnly = { ...context, agents: [{ name: "plain", model: plain }] };
  const changed = chooseAgent(draft, "plain", modelOnly);
  assertEquals(changed.model, plain);
  assertEquals(changed.variant, undefined);
  assertEquals(effectiveSelection(changed, modelOnly).variant, {
    value: undefined,
    source: "explicit",
  });
  const variantOnly = {
    ...context,
    agents: [{ name: "effort", variant: "low" }],
  };
  assertEquals(chooseAgent(draft, "effort", variantOnly).variant, "low");
  const invalid = {
    ...context,
    agents: [{ name: "bad", model: plain, variant: "low" }],
  };
  const invalidChoice = chooseAgent(draft, "bad", invalid);
  assertEquals(invalidChoice.variant, "low");
  assertEquals(effectiveSelection(invalidChoice, invalid).variant, {
    source: "absent",
  });
  // Agent metadata is retained even before catalog loading; resolution validates it.
  const loading = { agents: context.agents };
  const pending = chooseAgent(draft, "plan", loading);
  assertEquals(pending.model, second);
  assertEquals(pending.variant, "medium");
  assertEquals(effectiveSelection(pending, loading).variant, {
    value: "medium",
    source: "explicit",
  });
  assertEquals(effectiveSelection(pending, context).variant.value, "medium");
});

Deno.test("unknown catalog preserves explicit and restored variants until loaded negative membership, and model choice does not erase unknown variants", () => {
  for (const explicit of [true, false]) {
    const draft = explicit
      ? { ...emptyDraft(), model: first, variant: "high" }
      : emptyDraft();
    const unknown = {
      agents: [],
      context: explicit ? undefined : { model: first, variant: "high" },
    };
    const selection = effectiveSelection(draft, unknown);
    assertEquals(selection.variant.value, "high");
    assertEquals(selection.input.variant, "high");
    assertEquals(
      effectiveSelection(draft, { ...unknown, catalog: { providers: [] } })
        .variant,
      { source: "absent" },
    );
  }
  const choice = chooseModel({ ...emptyDraft(), variant: "high" }, second, {
    agents: [],
  });
  assertEquals(choice.variant, "high");
  assertEquals(
    effectiveSelection(choice, { agents: [] }).input.variant,
    "high",
  );
  const shell = effectiveSelection({ ...choice, mode: "shell" }, {
    agents: [],
    catalog,
  });
  assertEquals(shell.applies.variant, false);
  assertEquals(Object.hasOwn(shell.input, "variant"), false);
  assertEquals(shell.input.model, second);
});

Deno.test("model intent keeps advertised explicit variants and clears unsupported variants across provider identity", () => {
  const draft = { ...emptyDraft(), model: first, variant: "low" };
  const input = { ...context, context: { variant: "high" } };
  const changed = chooseModel(draft, second, input);
  assertEquals(changed.model, second);
  assertEquals(changed.variant, undefined);
  assertEquals(effectiveSelection(changed, input).variant, {
    value: undefined,
    source: "explicit",
  });
  assertEquals(
    chooseModel({ ...draft, variant: "high" }, second, context).variant,
    "high",
  );
  assertEquals(chooseModel(draft, plain, context).variant, undefined);
  assertEquals(
    chooseModel(draft, { provider: "offline", model: "missing" }, context)
      .variant,
    undefined,
  );
  assertEquals(draft.variant, "low");
  const unset = chooseModel(emptyDraft(), second, context);
  assertEquals(Object.hasOwn(unset, "variant"), false);
});

Deno.test("variant intent accepts only advertised values and explicit Default survives restore and configured fallback", () => {
  const draft = emptyDraft();
  assertStrictEquals(chooseVariant(draft, "medium", context), draft);
  const high = chooseVariant(draft, "high", context);
  assertEquals(effectiveSelection(high, context).variant, {
    value: "high",
    source: "explicit",
  });
  const cleared = chooseVariant(high, undefined, context);
  assertEquals(
    effectiveSelection(cleared, { ...context, context: { variant: "high" } })
      .variant,
    { value: undefined, source: "explicit" },
  );
  assertEquals(effectiveSelection(cleared, context).variant, {
    value: undefined,
    source: "explicit",
  });
  assertEquals(
    effectiveSelection(chooseModel(cleared, second, context), context).variant,
    { value: undefined, source: "explicit" },
  );
  assertStrictEquals(
    chooseVariant({ ...draft, model: plain }, "high", context).model,
    plain,
  );
  const restored = { ...context, context: { model: second } };
  assertEquals(chooseVariant(draft, "medium", restored).variant, "medium");
});

Deno.test("draft choices stay server/session keyed across content clearing, reopen and a late send", () => {
  const drafts = createDrafts();
  const a = drafts.writer("one/session"), b = drafts.writer("two/session");
  const submitted = a(
    chooseAgent(
      { ...emptyDraft(), input: "Send me", editor: { text: "editing" } },
      "plan",
      context,
    ),
  );
  b(chooseVariant(
    { ...emptyDraft(), input: "Other server" },
    undefined,
    context,
  ));
  a((current) => current === submitted ? clearDraft(current) : current);
  const reopened = drafts.get("one/session");
  assertEquals(reopened.input, "");
  assertEquals(reopened.chips, []);
  assertEquals(reopened.editor, undefined);
  assertEquals(effectiveSelection(reopened, context).model.value, second);
  assertEquals(effectiveSelection(reopened, context).variant.value, "medium");
  assertEquals(
    effectiveSelection(clearDraft(b((current) => current)), context).variant,
    { value: undefined, source: "explicit" },
  );
  assertEquals(Object.hasOwn(clearDraft(emptyDraft()), "variant"), false);
  const newer = a((current) =>
    chooseModel({ ...current, input: "New edit" }, first, context)
  );
  a((current) => current === submitted ? clearDraft(current) : current);
  assertStrictEquals(drafts.get("one/session"), newer);
  assertEquals(drafts.get("two/session").input, "Other server");
  assertEquals(drafts.get("one/another-session"), emptyDraft());
});
