// SPDX-License-Identifier: LGPL-3.0-only
import type { FailureValue } from "./failure-features.ts";
import { createState, type StateFactory } from "./state.ts";

export interface InlineRenameState<T> {
  input?: string;
  editing?: T;
  pendingTitle?: string;
  invalid?: string;
  error?: FailureValue;
}

/** Data and events the shared field needs, independent of target identity. */
export interface InlineRenameField<T> {
  readonly state: InlineRenameState<T>;
  readonly editing: boolean;
  edit(value: string): void;
  cancel(): void;
  commit(value: string, trigger?: "blur"): Promise<void>;
}

export interface InlineRename<T> extends InlineRenameField<T> {
  start(target: T): void;
  observe(): void;
  matches(target: T): boolean;
  snapshot(): unknown;
  restore(value: unknown): void;
}

/** Editing and mutation admission live here, not in the surfaces that render it. */
export function createInlineRename<T extends { title: string }>(o: {
  same(a: T, b: T): boolean;
  rename(target: T, value: string): Promise<unknown>;
  current?(target: T): string | undefined;
  validate?(value: string): string | undefined;
  failure(error: unknown, target: T): FailureValue;
  factory?: StateFactory;
}): InlineRename<T> {
  const store = (o.factory ?? createState)<InlineRenameState<T>>({});
  let editing: T | undefined;
  let generation = 0;
  let waitingTitle: string | undefined;
  const cancel = () => {
    generation++;
    editing = undefined;
    waitingTitle = undefined;
    store.update((state) => {
      state.editing = undefined;
      state.invalid = undefined;
      state.error = undefined;
      state.pendingTitle = undefined;
    });
  };
  return {
    state: store.state,
    get editing() {
      return !!store.state.editing && store.state.pendingTitle === undefined &&
        !store.state.error;
    },
    edit: (value) =>
      store.update((state) => {
        state.input = value;
        state.invalid = undefined;
        state.error = undefined;
      }),
    snapshot: () =>
      store.state.pendingTitle === undefined && !store.state.error
        ? { editing, input: store.state.input }
        : {},
    restore(value) {
      const saved = value as Pick<InlineRenameState<T>, "editing" | "input">;
      editing = saved.editing;
      store.update((state) => {
        state.editing = editing;
        state.input = saved.input;
      });
    },
    start(target) {
      cancel();
      editing = target;
      store.update((state) => {
        state.editing = target;
        state.input = target.title;
      });
    },
    cancel,
    observe() {
      const value = editing && o.current?.(editing);
      if (waitingTitle !== undefined && value === waitingTitle) cancel();
    },
    matches(target) {
      const active = store.state.editing;
      return active !== undefined && o.same(active, target);
    },
    async commit(input, trigger) {
      if (!editing || store.state.pendingTitle !== undefined) return;
      // A delayed blur may follow Enter even after a fast rejection. Only
      // another explicit submit or a new edit can retry the rejected draft.
      if (trigger === "blur" && (store.state.error || store.state.invalid)) {
        return;
      }
      const value = input.trim();
      const invalid = o.validate?.(value);
      if (invalid) {
        store.update((state) => {
          state.input = input;
          state.invalid = invalid;
          state.error = undefined;
        });
        return;
      }
      if (!value || value === editing.title) {
        cancel();
        return;
      }
      const target = editing, current = generation;
      store.update((state) => {
        state.input = input;
        state.pendingTitle = value;
        state.invalid = undefined;
        state.error = undefined;
      });
      try {
        await o.rename(target, value);
        if (generation !== current) return;
        if (!o.current || o.current(target) === value) cancel();
        else waitingTitle = value;
      } catch (error) {
        if (generation !== current) return;
        store.update((state) => {
          state.pendingTitle = undefined;
          state.error = o.failure(error, target);
        });
      }
    },
  };
}
