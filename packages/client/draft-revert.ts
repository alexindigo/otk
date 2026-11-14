// SPDX-License-Identifier: LGPL-3.0-only
import type { Draft, DraftChange } from "./drafts.ts";
import { replaceDraftContent } from "./drafts.ts";
import { hasDraftContent } from "./draft-content.ts";

export interface RevertDraft {
  readonly before: Draft;
  readonly current: Draft;
  readonly boundary?: string;
  readonly edited: boolean;
}
export interface DraftRevertCapture {
  staged(boundary: string): void;
  recall(content: Pick<Draft, "input" | "chips" | "mode">): void;
}
export interface DraftReverts {
  capture(key: string, boundary?: string): DraftRevertCapture;
  restorer(
    key: string,
    boundary?: string,
  ): () => "restored" | "edited" | "absent";
  /** Decision 47 seam: retain both values without choosing a conflict flow. */
  get(key: string): RevertDraft | undefined;
  drop(key: string): void;
}

/** Same lifetime/storage boundary as drafts; no selected-view or reload storage. */
export function createDraftReverts(drafts: {
  current(key: string): Draft;
  /** Writes by this transaction, distinct from ordinary composer edits. */
  writer(key: string): (change: DraftChange) => Draft;
}): DraftReverts & { changed(key: string): void } {
  const values = new Map<string, {
    before: Draft;
    boundary?: string;
    recalled: boolean;
    edited: boolean;
    revision: number;
  }>();
  return {
    capture(key, boundary) {
      const write = drafts.writer(key);
      let value = values.get(key);
      if (!boundary || value?.boundary !== boundary) {
        const current = drafts.current(key);
        value = {
          before: structuredClone(current),
          recalled: false,
          edited: false,
          revision: 0,
        };
        values.set(key, value);
      }
      const captured = value!;
      const revision = ++captured.revision;
      const invocation = drafts.current(key);
      const active = () =>
        values.get(key) === captured && captured.revision === revision;
      return {
        staged(boundary) {
          if (active()) captured.boundary = boundary;
        },
        recall(content) {
          if (!active()) return;
          write((draft) => {
            if (
              draft !== invocation ||
              ((captured.edited || !captured.recalled) &&
                (hasDraftContent(draft) || draft.editor))
            ) return draft;
            captured.recalled = true;
            return replaceDraftContent(draft, content);
          });
        },
      };
    },
    restorer(key, boundary) {
      const value = values.get(key);
      const revision = value?.revision;
      return () => {
        if (
          !boundary || !value || value.boundary !== boundary ||
          values.get(key) !== value || value.revision !== revision
        ) return "absent";
        if (value.edited) return "edited";
        values.delete(key);
        drafts.writer(key)(structuredClone(value.before));
        return "restored";
      };
    },
    get(key) {
      const value = values.get(key);
      if (!value) return;
      const current = drafts.current(key);
      return {
        before: structuredClone(value.before),
        current,
        boundary: value.boundary,
        edited: value.edited,
      };
    },
    drop(key) {
      values.delete(key);
    },
    changed(key) {
      const value = values.get(key);
      if (value) value.edited = true;
    },
  };
}
