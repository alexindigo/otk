// SPDX-License-Identifier: LGPL-3.0-only
import type { Activity, DisclosureCategory, Part } from "@otk/protocol";
import { countLabel } from "./count.ts";
import type { TranscriptInteraction } from "./transcript-interaction.ts";

export interface RecordKindFold {
  category: DisclosureCategory;
  label: string;
  count: number;
}

/** These records carry step or outcome facts, not Work log rows. */
export function workLogBookkeeping(
  part: Part,
): "step" | "completion" | undefined {
  if (part.kind === "step") return "step";
  if (part.kind !== "external" || part.failure) return;
  const value = part.activity;
  if (!value || !settledRecord(value)) return;
  if (value.completion?.placement === "footer") return "completion";
  if (value.fold && value.category === "stepMarkers") return "step";
}

function settledRecord(value: Activity) {
  return value.tone !== "error" &&
    (!value.state || value.state.facts.active === false &&
        value.state.facts.terminal === true);
}
export const recordKindKey = (owner: string, category: DisclosureCategory) =>
  `${owner}:kind:${category}`;
/** A revealed category borrows its frame's generation, including deletion. */
export function recordKindDisclosure(
  interaction: TranscriptInteraction,
  owner: string,
  category: DisclosureCategory,
): ReturnType<TranscriptInteraction["disclosure"]> {
  return interaction.disclosure(
    "recordKinds",
    recordKindKey(owner, category),
    interaction.generation(owner),
  );
}
/** Folding is presentation only. Failure/active/unknown-state facts never fold. */
export function foldRecords<T>(
  items: readonly T[],
  activity: (item: T) => Activity | undefined,
  expanded: (category: DisclosureCategory) => boolean,
  count: (item: T) => number = () => 1,
): { visible: T[]; folds: RecordKindFold[] } {
  const kinds = new Map<
    DisclosureCategory,
    { count: number; summary: NonNullable<Activity["summary"]> }
  >();
  const visible = items.filter((item) => {
    const value = activity(item);
    if (!value?.fold || !value.summary || !settledRecord(value)) return true;
    const kind = kinds.get(value.category) ??
      { count: 0, summary: value.summary };
    kind.count += count(item);
    kinds.set(value.category, kind);
    return expanded(value.category);
  });
  return {
    visible,
    folds: [...kinds].map(([category, { count, summary }]) => ({
      category,
      count,
      label: countLabel(count, summary.noun, summary.plural),
    })),
  };
}
