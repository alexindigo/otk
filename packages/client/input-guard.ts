// SPDX-License-Identifier: LGPL-3.0-only
import type { Drafts } from "./drafts.ts";

export interface InputGuard {
  mark(owner: string, dirty: boolean): void;
  dirty(owner: string): boolean;
  clear(): void;
  release(): boolean;
  permit(owner: string, message: string): boolean;
}
export function createInputGuard(
  o: { drafts: Drafts; key(): string; confirm(message: string): boolean },
): InputGuard {
  const dirty = new Map<string, boolean>();
  return {
    mark(owner, value) {
      dirty.set(owner, value);
    },
    dirty: (owner) => !!dirty.get(owner),
    clear() {
      dirty.clear();
    },
    release() {
      // Frameworks can batch painted reads during input events. Use the same
      // owner-current writer port as the composer, not the previous paint.
      const current = o.drafts.writer(o.key())((value) => value);
      if (!current.editor && ![...dirty.values()].some(Boolean)) return true;
      if (
        !o.confirm(
          "Discard unsaved editor or attention input before switching sessions?",
        )
      ) return false;
      if (current.editor) {
        o.drafts.writer(o.key())((value) => ({ ...value, editor: undefined }));
      }
      return true;
    },
    permit: (owner, message) => !dirty.get(owner) || o.confirm(message),
  };
}
