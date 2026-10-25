// SPDX-License-Identifier: LGPL-3.0-only
import { createState, type StateFactory } from "./state.ts";

export interface ForkNote {
  from: string;
}
export interface ForkNotes {
  get(key: string): ForkNote | undefined;
  add(key: string, from: string): void;
  dismiss(key: string): void;
  submission<T>(key: string, action: () => Promise<T>): Promise<T>;
}
/** Browser-lifetime metadata only; no transcript or draft is copied here. */
export function createForkNotes(
  factory: StateFactory = createState,
): ForkNotes {
  const notes = new Map<string, ForkNote>();
  const store = factory({ revision: 0 });
  const changed = () =>
    store.update((state) => {
      state.revision++;
    });
  const dismiss = (key: string) => {
    if (notes.delete(key)) changed();
  };
  return {
    get(key) {
      store.state.revision;
      return notes.get(key);
    },
    add(key, from) {
      notes.set(key, { from });
      changed();
    },
    dismiss,
    async submission(key, action) {
      const note = notes.get(key);
      const result = await action();
      if (notes.get(key) === note) dismiss(key);
      return result;
    },
  };
}
