// SPDX-License-Identifier: LGPL-3.0-only
import { errorMessage } from "@otk/protocol";
import type { Selection } from "./session.ts";
import { createState, type StateFactory } from "./state.ts";

export type RenameOrigin = "tab" | "chip" | "row";
export interface RenameTarget extends Selection {
  title: string;
}
export interface SessionRenameState {
  editing?: RenameTarget & { origin: RenameOrigin };
  pending: boolean;
  error?: string;
}
export interface SessionRename {
  readonly state: SessionRenameState;
  start(target: RenameTarget, origin: RenameOrigin): void;
  cancel(): void;
  commit(title: string): Promise<void>;
  matches(target: Selection, origin: RenameOrigin): boolean;
  observe(): void;
}

/** Editing and request identity live here, not in tabs, rows or their inputs. */
export function createSessionRename(options: {
  rename(target: Selection, title: string): Promise<unknown>;
  factory?: StateFactory;
  title?(target: Selection): string | undefined;
}): SessionRename {
  const store = (options.factory ?? createState)<SessionRenameState>({
    pending: false,
  });
  let editing: SessionRenameState["editing"];
  let generation = 0;
  let pending = false;
  let waitingTitle: string | undefined;
  const cancel = () => {
    generation++;
    editing = undefined;
    pending = false;
    waitingTitle = undefined;
    store.update((state) => {
      state.editing = undefined;
      state.error = undefined;
      state.pending = false;
    });
  };
  return {
    state: store.state,
    start(target, origin) {
      cancel();
      editing = { ...target, origin };
      store.update((state) => {
        state.editing = editing;
      });
    },
    cancel,
    observe() {
      if (
        editing && waitingTitle !== undefined &&
        options.title?.(editing) === waitingTitle
      ) cancel();
    },
    matches(target, origin) {
      const active = store.state.editing;
      return !!active && active.origin === origin &&
        active.sidecarId === target.sidecarId &&
        active.sessionID === target.sessionID;
    },
    async commit(input) {
      if (!editing || pending) return;
      const title = input.trim();
      if (!title || title === editing.title) {
        cancel();
        return;
      }
      const target = editing, current = generation;
      pending = true;
      store.update((state) => {
        state.pending = true;
        state.error = undefined;
      });
      try {
        await options.rename(target, title);
        if (generation !== current) return;
        if (!options.title || options.title(target) === title) cancel();
        else waitingTitle = title;
      } catch (error) {
        if (generation !== current) return;
        pending = false;
        store.update((state) => {
          state.pending = false;
          state.error = errorMessage(error);
        });
      }
    },
  };
}
