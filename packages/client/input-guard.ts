// SPDX-License-Identifier: LGPL-3.0-only
import type { Drafts } from "./drafts.ts";

export interface ReleaseInput {
  /** Stored drafts survive ordinary navigation; destructive releases say otherwise. */
  draft: "kept" | "dropped";
  /** Captured draft identities being released; defaults to the current session. */
  keys?: readonly string[];
}

export interface InputGuard {
  mark(owner: string, dirty: boolean, input?: string): void;
  retained(): { owner: string; value: string }[];
  dirty(owner: string): boolean;
  clear(): void;
  release(input?: ReleaseInput): boolean;
  permit(owner: string, message: string): boolean;
}
export function createInputGuard(
  o: {
    drafts: Drafts;
    key(): string;
    confirm(message: string): boolean;
    retain?(): boolean;
  },
): InputGuard {
  const dirty = new Map<string, boolean>();
  const inputs = new Map<string, string>();
  return {
    mark(owner, value, input) {
      if (!value && dirty.get(owner) && o.retain?.()) return;
      dirty.set(owner, value);
      if (input !== undefined) inputs.set(owner, input);
      if (!value) inputs.delete(owner);
    },
    retained: () =>
      [...inputs].filter(([owner]) => dirty.get(owner)).map((
        [owner, value],
      ) => ({ owner, value })),
    dirty: (owner) => !!dirty.get(owner),
    clear() {
      dirty.clear();
      inputs.clear();
    },
    release(input = { draft: "kept" }) {
      // Frameworks can batch painted reads during input events. The plain
      // current read never creates a draft while checking what would be lost.
      const key = o.key(), keys = input.keys ?? [key];
      const drafts = keys.map((key) => o.drafts.current(key));
      // Stored attachments survive mode switches, even when the current mode
      // would not submit them. Losing a draft is distinct from sendability.
      const losesDraft = input.draft === "dropped" &&
        drafts.some((draft) => !!draft.input.trim() || draft.chips.length > 0);
      const losesInput = drafts.some((draft) => !!draft.editor) ||
        (keys.includes(key) && [...dirty.values()].some(Boolean));
      if (!losesDraft && !losesInput) return true;
      if (
        !o.confirm(
          losesDraft
            ? "Discard unsent draft and unsaved input before continuing?"
            : "Discard unsaved editor or attention input before switching sessions?",
        )
      ) return false;
      // A destructive mutation may still fail. Its caller drops drafts only
      // after success; consent alone never consumes the draft or its editor.
      if (input.draft === "kept") {
        for (const key of keys) {
          o.drafts.writer(key)((value) =>
            value.editor ? { ...value, editor: undefined } : value
          );
        }
      }
      return true;
    },
    permit: (owner, message) => !dirty.get(owner) || o.confirm(message),
  };
}
