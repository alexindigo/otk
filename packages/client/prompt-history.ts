// SPDX-License-Identifier: LGPL-3.0-only
import { type HistoryEntry, sameHistory } from "@otk/protocol";
import type { PromptPart } from "@otk/protocol";
import {
  type Draft,
  type DraftChange,
  emptyDraft,
  replaceDraftContent,
} from "./drafts.ts";
import { hasDraftContent, serialize } from "./draft-content.ts";
function label(part: PromptPart, count: number): string {
  if (part.kind === "agent") return `@${part.name}`;
  if (part.kind === "text") return part.text;
  if (part.source === "path") {
    return part.label ||
      `@${part.path}${
        part.range
          ? `#${part.range.start}${
            part.range.end === undefined ? "" : `-${part.range.end}`
          }`
          : ""
      }`;
  }
  if (part.source === "resource") return part.label || `@${part.name}`;
  return `[${
    part.mime === "application/pdf"
      ? "PDF"
      : part.mime.startsWith("image/")
      ? "Image"
      : "File"
  } ${count}]`;
}
export function historyDraft(entry: HistoryEntry): Draft {
  const draft: Draft = { input: entry.input, mode: entry.mode, chips: [] },
    counts = new Map<string, number>();
  let cursor = 0;
  for (const part of entry.parts) {
    if (part.kind === "text") continue;
    const category = part.kind === "file" &&
        (part.source === "upload" || part.source === "history")
      ? part.mime === "application/pdf"
        ? "PDF"
        : part.mime.startsWith("image/")
        ? "Image"
        : "File"
      : part.kind;
    const count = (counts.get(category) || 0) + 1;
    counts.set(category, count);
    const token = label(part, count);
    // History is metadata-only: images remain independent without fetching bytes
    // or manufacturing a text token that was not in the user's prompt.
    if (
      part.kind === "file" &&
      (part.source === "upload" || part.source === "history") &&
      part.mime.startsWith("image/") && !draft.input.includes(token)
    ) {
      draft.chips.push({ id: crypto.randomUUID(), label: token, part });
      continue;
    }
    let start = draft.input.indexOf(token, cursor);
    if (start < 0) {
      start = draft.input.length;
      draft.input += (draft.input.endsWith(" ") || !draft.input ? "" : " ") +
        token;
      start = draft.input.length - token.length;
    }
    const end = start + token.length;
    draft.chips.push({
      id: crypto.randomUUID(),
      label: token,
      start,
      end,
      part,
    });
    cursor = end;
  }
  return draft;
}
export class PromptHistory {
  #entries: HistoryEntry[] = [];
  #index = -1;
  #last: Draft | undefined;
  get empty(): boolean {
    return this.#index === -1;
  }
  canMove(draft: Draft): boolean {
    return !hasDraftContent(draft) ||
      (!!this.#last &&
        sameHistory({ ...draft, parts: serialize(draft) }, {
          ...this.#last,
          parts: serialize(this.#last),
        }));
  }
  replace(entries: HistoryEntry[]): void {
    this.#entries = entries.slice(0, 50);
    this.#index = -1;
    this.#last = undefined;
  }
  move(direction: -1 | 1, draft: Draft): Draft | undefined {
    if (!this.canMove(draft)) return;
    const next = this.#index - direction;
    if (next < -1 || next >= this.#entries.length) return;
    this.#index = next;
    return this.#last = next === -1
      ? emptyDraft()
      : historyDraft(this.#entries[next]);
  }
  reset(): void {
    this.#entries = [];
    this.#index = -1;
    this.#last = undefined;
  }
}

export interface PromptHistoryOptions {
  available(): boolean;
  load(): Promise<HistoryEntry[]>;
  /** A session-bound writer; the optional caret is a native input intent. */
  change(update: DraftChange, caret?: number): Draft;
  fail(error: unknown): void;
}
export interface PromptHistoryOwner {
  canMove(draft: Draft): boolean;
  recall(direction: -1 | 1): Promise<void>;
  reset(): void;
  dispose(): void;
}

/** One per-prompt recall queue and lifetime, independent of rendered state. */
export function createPromptHistory(
  options: PromptHistoryOptions,
): PromptHistoryOwner {
  const history = new PromptHistory();
  let queue = Promise.resolve(), generation = 0, disposed = false;
  const current = (at: number) =>
    !disposed && generation === at && options.available();
  const read = () => options.change((draft) => draft);
  const reset = () => {
    generation++;
    history.reset();
  };
  return {
    canMove: (draft) => !disposed && history.canMove(draft),
    recall(direction) {
      const at = generation;
      const work = queue.then(async () => {
        if (!current(at)) return;
        const draft = read();
        if (!history.canMove(draft)) return;
        if (history.empty) {
          const entries = await options.load();
          if (!current(at) || read() !== draft) return;
          history.replace(entries);
        }
        const next = history.move(direction, draft);
        if (next) {
          options.change(
            (current) =>
              current === draft ? replaceDraftContent(current, next) : current,
            direction === -1 ? 0 : next.input.length,
          );
        }
      }).catch((error) => {
        if (current(at)) options.fail(error);
      });
      // A reporting sink can throw; later intents still own a usable queue.
      queue = work.catch(() => {});
      return work;
    },
    reset,
    dispose() {
      disposed = true;
      reset();
    },
  };
}
