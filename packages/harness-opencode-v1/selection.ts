// SPDX-License-Identifier: LGPL-3.0-only
import type { ModelRef } from "@otk/protocol";

/** The only V1 builders of native model payloads. Explicit Default (null) and
 * an unknown applied variant both omit the native field; V1 has no inherit. */
export function nativeModel(
  model: ModelRef,
): { providerID: string; modelID: string } {
  return { providerID: model.provider, modelID: model.model };
}
/** Native command routes name their model as `provider/model`. */
export function nativeCommandModel(model: ModelRef): string {
  return `${model.provider}/${model.model}`;
}
export function nativeVariant(
  variant: string | null | undefined,
): string | undefined {
  return typeof variant === "string" ? variant : undefined;
}

interface SelectionRecord {
  id: string;
  model?: { providerID?: unknown; modelID?: unknown; variant?: unknown } | null;
}
/** Native's next-selection authority is its newest user-role record, but a
 * synthetic one (compaction, shell) cannot carry a variant. When it repeats
 * the newest prompt's model, that prompt's applied variant still holds. */
export function inheritedVariant(
  authority: SelectionRecord | undefined,
  prompt: SelectionRecord | undefined,
): string | undefined {
  const own = authority?.model?.variant;
  if (typeof own === "string") return own;
  // The newest prompt is itself the authority: its omitted variant is Default.
  if (!authority?.model || !prompt?.model || authority.id === prompt.id) {
    return;
  }
  const same = authority.model.providerID === prompt.model.providerID &&
    authority.model.modelID === prompt.model.modelID;
  return same && typeof prompt.model.variant === "string"
    ? prompt.model.variant
    : undefined;
}
