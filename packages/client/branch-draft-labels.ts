// SPDX-License-Identifier: LGPL-3.0-only
export const branchDraftLabels = {
  beforeRevert: "Before revert",
  atRevert: "At revert",
  keptComposer: "Kept composer draft",
  beforeSending: "Before sending",
  beforeRestore: "Before restore",
  savedDraft: "Saved draft",
  savedPrompt: "Saved prompt",
} as const;
/** Normalize existing browser entries too, without rewriting their content. */
export function branchDraftLabel(label: string): string {
  return Object.values(branchDraftLabels).find((value) =>
    value.toLowerCase() === label.toLowerCase()
  ) ?? label;
}
