// SPDX-License-Identifier: LGPL-3.0-only
import type { PromptPart } from "@otk/protocol";
import { type Chip, type Draft, replaceDraftContent } from "./drafts.ts";
import { countLabel } from "./count.ts";
// The owner applies transforms synchronously to its latest proposed draft and
// returns that draft, even when rendered inputs still show a committed snapshot.
export function inlineChip(
  chip: Chip,
): chip is Chip & { start: number; end: number } {
  return chip.start !== undefined && chip.end !== undefined;
}
export function attachChip(
  draft: Draft,
  label: string,
  part: PromptPart,
): Draft {
  return {
    ...draft,
    chips: [...draft.chips, { id: crypto.randomUUID(), label, part }],
  };
}
export function removeChip(draft: Draft, id: string): Draft {
  const chip = draft.chips.find((chip) => chip.id === id);
  if (!chip) return draft;
  return inlineChip(chip)
    ? editDraft(
      draft,
      draft.input.slice(0, chip.start) + draft.input.slice(chip.end),
    )
    : { ...draft, chips: draft.chips.filter((chip) => chip.id !== id) };
}
export function hasDraftContent(draft: Draft): boolean {
  return !!draft.input.trim() ||
    (draft.mode === "normal" && draft.chips.length > 0);
}
export function editDraft(draft: Draft, input: string): Draft {
  let start = 0, oldEnd = draft.input.length, end = input.length;
  while (start < oldEnd && start < end && draft.input[start] === input[start]) {
    start++;
  }
  while (
    oldEnd > start && end > start && draft.input[oldEnd - 1] === input[end - 1]
  ) {
    oldEnd--;
    end--;
  }
  const delta = end - oldEnd;
  return {
    ...draft,
    input,
    chips: draft.chips.flatMap((chip) => {
      if (!inlineChip(chip)) return [chip];
      if (chip.end <= start) return [chip];
      if (chip.start >= oldEnd) {
        return [{ ...chip, start: chip.start + delta, end: chip.end + delta }];
      }
      return [];
    }),
  };
}
export function insertChip(
  draft: Draft,
  start: number,
  end: number,
  label: string,
  part: PromptPart,
): Draft {
  const next = editDraft(
    draft,
    draft.input.slice(0, start) + label + " " + draft.input.slice(end),
  );
  return {
    ...next,
    chips: [...next.chips, {
      id: crypto.randomUUID(),
      label,
      part,
      start,
      end: start + label.length,
    }].sort((a, b) => (a.start ?? Infinity) - (b.start ?? Infinity)),
  };
}
export function serialize(draft: Draft): PromptPart[] {
  let input = draft.input;
  for (const chip of [...draft.chips].reverse()) {
    if (chip.part.kind === "text" && inlineChip(chip)) {
      input = input.slice(0, chip.start) + chip.part.text +
        input.slice(chip.end);
    }
  }
  return [
    { kind: "text", text: input },
    ...draft.chips.filter((chip) => chip.part.kind !== "text").map((chip) =>
      chip.part
    ),
  ];
}
export function editorSave(draft: Draft): Draft {
  const editor = draft.editor;
  if (!editor) return draft;
  if (editor.chipID) {
    const chip = draft.chips.find((chip) => chip.id === editor.chipID);
    if (!chip || !inlineChip(chip)) {
      throw new Error("Edited paste was removed from the prompt");
    }
    const label = pasteLabel(editor.text),
      next = editDraft(
        draft,
        draft.input.slice(0, chip.start) + label + draft.input.slice(chip.end),
      );
    return {
      ...next,
      editor: undefined,
      chips: [...next.chips, {
        ...chip,
        label,
        end: chip.start + label.length,
        part: { kind: "text" as const, text: editor.text },
      }].sort((a, b) => (a.start ?? Infinity) - (b.start ?? Infinity)),
    };
  }
  let cursor = 0;
  const chips = draft.chips.flatMap((chip) => {
    if (!inlineChip(chip)) return [chip];
    const start = editor.text.indexOf(chip.label, cursor);
    if (start < 0) return [];
    cursor = start + chip.label.length;
    return [{ ...chip, start, end: cursor }];
  });
  return replaceDraftContent(draft, {
    input: editor.text,
    mode: draft.mode,
    chips,
  });
}
export const pasteLabel = (text: string): string =>
  `[Pasted ~${countLabel(text.split("\n").length, "line")}]`;
