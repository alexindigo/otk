// SPDX-License-Identifier: LGPL-3.0-only
import {
  type HistoryEntry,
  sameHistory,
} from "../../../../protocol/history.ts";
import type { PromptPart } from "../../../../protocol/rpc.ts";
import { type Draft, emptyDraft, serialize } from "./model.ts";
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
  get empty() {
    return this.#index === -1;
  }
  canMove(draft: Draft): boolean {
    return !draft.input ||
      (!!this.#last &&
        sameHistory({ ...draft, parts: serialize(draft) }, {
          ...this.#last,
          parts: serialize(this.#last),
        }));
  }
  replace(entries: HistoryEntry[]) {
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
  reset() {
    this.#entries = [];
    this.#index = -1;
    this.#last = undefined;
  }
}
