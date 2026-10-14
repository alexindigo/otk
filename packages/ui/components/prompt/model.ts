// SPDX-License-Identifier: LGPL-3.0-only
import type { PromptPart } from "@otk/protocol";
export interface Chip {
  id: string;
  label: string;
  start: number;
  end: number;
  part: PromptPart;
  pending?: boolean;
  error?: string;
}
export interface Draft {
  input: string;
  chips: Chip[];
  mode: "normal" | "shell";
  editor?: { text: string; chipID?: string };
}
// The owner applies transforms synchronously to its latest proposed draft and
// returns that draft, even when rendered inputs still show a committed snapshot.
export type DraftChange = Draft | ((current: Draft) => Draft);
export const emptyDraft = (): Draft => ({
  input: "",
  chips: [],
  mode: "normal",
});
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
    }].sort((a, b) => a.start - b.start),
  };
}
export function serialize(draft: Draft): PromptPart[] {
  let input = draft.input;
  for (const chip of [...draft.chips].reverse()) {
    if (chip.part.kind === "text") {
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
    if (!chip) throw new Error("Edited paste was removed from the prompt");
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
      }].sort((a, b) => a.start - b.start),
    };
  }
  let cursor = 0;
  const chips = draft.chips.flatMap((chip) => {
    const start = editor.text.indexOf(chip.label, cursor);
    if (start < 0) return [];
    cursor = start + chip.label.length;
    return [{ ...chip, start, end: cursor }];
  });
  return { ...draft, input: editor.text, chips, editor: undefined };
}
export const pasteLabel = (text: string): string =>
  `[Pasted ~${text.split("\n").length} lines]`;
