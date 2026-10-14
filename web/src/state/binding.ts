// SPDX-License-Identifier: LGPL-3.0-only
import { createStore, reconcile } from "solid-js";
import type { StateStore } from "@otk/client";

/** Keep Solid's granular draft updates and snapshot reconciliation at the UI edge. */
export function solidState<T extends object>(initial: T): StateStore<T> {
  const [root, update] = createStore<{ value: T }>({ value: initial });
  const state = root.value;
  const listeners = new Set<(state: T) => void>();
  return {
    state,
    update(change) {
      update((draft) => change(draft.value));
      queueMicrotask(() => {
        for (const listener of listeners) listener(state);
      });
    },
    reconcile(target, value) {
      reconcile(value)(target);
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
