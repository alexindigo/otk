// SPDX-License-Identifier: LGPL-3.0-only
import type {
  AgentOption,
  ModelCatalog,
  ModelRef,
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
}
export interface PromptSelectionContext {
  /** The last loaded user message, never copied into the draft. */
  context?: Pick<UserMessage, "agent" | "model" | "variant">;
  /** Primary, non-hidden agents, in the backend's configured-default order. */
  agents: readonly AgentOption[];
  catalog?: ModelCatalog;
}
export interface PromptSelection {
  agent: SelectionField<string> & { color?: string };
  model: SelectionField<ModelRef> & {
    name?: string;
    providerName?: string;
    variants: readonly string[];
    unavailable: boolean;
  };
  variant: SelectionField<string>;
}
type Choices = Pick<Draft, "agent" | "model" | "variant">;

function resolve<T>(
  explicit: T | undefined,
  restored: T | undefined,
  configured?: T,
  fallback?: T,
): SelectionField<T> {
  if (explicit !== undefined) return { value: explicit, source: "explicit" };
  if (restored !== undefined) return { value: restored, source: "restored" };
  if (configured !== undefined) {
    return { value: configured, source: "configured" };
  }
  if (fallback !== undefined) return { value: fallback, source: "default" };
  return { source: "absent" };
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
  const variant = Object.hasOwn(draft, "variant")
    ? { value: draft.variant, source: "explicit" as const }
    : resolve(undefined, context?.variant, option?.variant);
  return {
    agent: { ...agent, color: option?.color },
    model: {
      ...model,
      name: info?.name || model.value?.model,
      providerName: provider?.name || model.value?.provider,
      variants: info?.variants ?? [],
      unavailable: model.value !== undefined && !info,
    },
    variant:
      variant.value === undefined || info?.variants.includes(variant.value)
        ? variant
        : { source: "absent" },
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
  return draft.variant !== undefined && !info?.variants.includes(draft.variant)
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
    variant !== undefined &&
    !effectiveSelection(draft, context).model.variants.includes(variant)
  ) return draft;
  return { ...draft, variant };
}
