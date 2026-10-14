// SPDX-License-Identifier: LGPL-3.0-only
/** Observable mutable state; framework bindings supply the same small contract. */
export interface StateStore<T extends object> {
  state: T;
  update(change: (draft: T) => void): void;
  reconcile<V extends object>(target: V, value: V): void;
  subscribe(listener: (state: T) => void): () => void;
}
export type StateFactory = <T extends object>(initial: T) => StateStore<T>;
/** Plain synchronous state, with notifications after each committed update. */
export function createState<T extends object>(initial: T): StateStore<T> {
  const listeners = new Set<(state: T) => void>();
  return {
    state: initial,
    update(change) {
      change(initial);
      for (const listener of listeners) listener(initial);
    },
    reconcile(target, value) {
      for (const key of Object.keys(target) as (keyof typeof target)[]) {
        if (!Object.hasOwn(value, key)) delete target[key];
      }
      Object.assign(target, value);
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
