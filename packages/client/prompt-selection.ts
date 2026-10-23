// SPDX-License-Identifier: LGPL-3.0-only
import type {
  AgentOption,
  ModelCatalog,
  ModelRef,
  PromptInput,
  UserMessage,
} from "@otk/protocol";
import type { Draft } from "./drafts.ts";

export type SelectionSource =
  | "explicit"
  | "restored"
  | "configured"
  | "default"
  | "absent";

export interface SelectionField<T> {
  value?: T;
  source: SelectionSource;
  /** Explicit choices and this session's restored choices belong to the user. */
  userChosen: boolean;
}
export interface PromptSelectionContext {
  /** The last loaded user message, never copied into the draft. */
  context?: Pick<UserMessage, "agent" | "model" | "variant">;
  /** Primary, non-hidden agents, in the backend's configured-default order. */
  agents: readonly AgentOption[];
  catalog?: ModelCatalog;
}
export interface PromptSelection {
  applies: { agent: true; model: true; variant: boolean };
  input: PromptChoices;
  agent: SelectionField<string> & { color?: AgentOption["color"] };
  model: SelectionField<ModelRef> & {
    name?: string;
    providerName?: string;
    variants: readonly string[];
    unavailable: boolean;
  };
  variant: SelectionField<string>;
  /** Selected menu row / cycle position, independent of the applied value. */
  variantChoice?: string;
}
export type PromptChoices = Pick<PromptInput, "agent" | "model" | "variant">;
type Choices =
  & Pick<Draft, "agent" | "model" | "variant">
  & Partial<Pick<Draft, "mode">>;

function resolve<T>(
  explicit: T | undefined,
  restored: T | undefined,
  configured?: T,
  fallback?: T,
): SelectionField<T> {
  if (explicit !== undefined) return field("explicit", explicit);
  if (restored !== undefined) return field("restored", restored);
  if (configured !== undefined) {
    return field("configured", configured);
  }
  if (fallback !== undefined) return field("default", fallback);
  return field("absent");
}

function field<T>(source: SelectionSource, value?: T): SelectionField<T> {
  return {
    ...(value !== undefined || source === "explicit" ? { value } : {}),
    source,
    userChosen: source === "explicit" || source === "restored",
  };
}

function modelInfo(model: ModelRef | undefined, catalog?: ModelCatalog) {
  const provider = catalog?.providers.find((item) =>
    item.id === model?.provider
  );
  const info = provider?.models.find((item) => item.id === model?.model);
  return { provider, info };
}

/** One projection for both next-prompt display and submission. No state is seeded. */
export function effectiveSelection(
  draft: Readonly<Choices>,
  { context, agents, catalog }: PromptSelectionContext,
): PromptSelection {
  const agent = resolve(draft.agent, context?.agent, agents[0]?.name);
  const option = agents.find((item) => item.name === agent.value);
  const model = resolve(
    draft.model,
    context?.model,
    option?.model,
    catalog?.default,
  );
  const { provider, info } = modelInfo(model.value, catalog);
  const valid = (value: string | undefined) =>
    value !== undefined &&
    (catalog === undefined || info?.variants.includes(value));
  // Native defaults apply only to the agent's own effective model. The same
  // fallback applies after Default or an invalid choice omits the wire field.
  const configuredVariant = option?.model?.provider === model.value?.provider &&
      option?.model?.model === model.value?.model && valid(option?.variant)
    ? option?.variant
    : undefined;
  const variant = Object.hasOwn(draft, "variant")
    ? field("explicit", draft.variant)
    : resolve(undefined, context?.variant, configuredVariant);
  const applies = {
    agent: true as const,
    model: true as const,
    variant: draft.mode !== "shell",
  };
  const requestedVariant = !applies.variant
    ? field<string>("absent")
    : variant.value === undefined || valid(variant.value)
    ? variant
    : field<string>("absent");
  const effectiveVariant = applies.variant &&
      requestedVariant.value === undefined && configuredVariant !== undefined
    ? field("configured", configuredVariant)
    : requestedVariant;
  return {
    applies,
    input: {
      agent: agent.value,
      model: model.value,
      ...(applies.variant ? { variant: requestedVariant.value } : {}),
    },
    agent: { ...agent, color: option?.color },
    model: {
      ...model,
      name: info?.name || model.value?.model,
      providerName: provider?.name ?? model.value?.provider,
      variants: info?.variants ?? [],
      unavailable: catalog !== undefined && model.value !== undefined && !info,
    },
    variant: effectiveVariant,
    variantChoice: requestedVariant.value,
  };
}

/** Selecting a model retains only explicit variants that it advertises. */
export function chooseModel(
  draft: Draft,
  model: ModelRef,
  { catalog }: PromptSelectionContext,
): Draft {
  const { info } = modelInfo(model, catalog);
  const next = { ...draft, model: { ...model } };
  return catalog !== undefined && draft.variant !== undefined &&
      !info?.variants.includes(draft.variant)
    ? { ...next, variant: undefined }
    : next;
}

/** An agent's configured choices apply on this intent, not on every projection. */
export function chooseAgent(
  draft: Draft,
  name: string,
  context: PromptSelectionContext,
): Draft {
  const agent = context.agents.find((item) => item.name === name);
  if (!agent) return draft;
  let next: Draft = { ...draft, agent: name };
  if (agent.model) next = chooseModel(next, agent.model, context);
  if (agent.variant !== undefined) {
    next = { ...next, variant: agent.variant };
  }
  return next;
}

/** Undefined deliberately selects Default, overriding restore/configuration. */
export function chooseVariant(
  draft: Draft,
  variant: string | undefined,
  context: PromptSelectionContext,
): Draft {
  if (
    context.catalog !== undefined && variant !== undefined &&
    !effectiveSelection(draft, context).model.variants.includes(variant)
  ) return draft;
  return { ...draft, variant };
}
