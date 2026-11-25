// SPDX-License-Identifier: LGPL-3.0-only
import { createState, type StateFactory } from "./state.ts";

export type TreeDisclosureKind =
  | "project"
  | "discovered"
  | "archive"
  | "inactive"
  | "task"
  | "ungrouped"
  | "session";
export interface TreeTarget {
  sidecarId?: string;
  id: string;
}
export interface TreeDisclosure {
  open(): boolean;
  pending(): boolean;
  error(): unknown;
  set(open: boolean): Promise<void>;
  retry(): Promise<void>;
}
export interface TreeDisclosures {
  bind(
    kind: TreeDisclosureKind,
    target: TreeTarget,
    baseline: () => boolean,
    save?: (open: boolean) => Promise<void>,
  ): TreeDisclosure;
}
/** Local intent is immediate; persistence for each identity is ordered. A late
 * acknowledgement or refusal can never replace a newer local choice. */
export function createTreeDisclosure(
  factory: StateFactory = createState,
): TreeDisclosures {
  const clock = factory({ revision: 0 });
  const entries = new Map<string, {
    intent?: boolean;
    revision: number;
    pending: boolean;
    error?: unknown;
    tail?: Promise<void>;
  }>();
  const publish = () =>
    clock.update((draft) => {
      draft.revision++;
    });
  return {
    bind(
      kind: TreeDisclosureKind,
      target: TreeTarget,
      baseline: () => boolean,
      save?: (open: boolean) => Promise<void>,
    ): TreeDisclosure {
      const key = JSON.stringify([kind, target.sidecarId, target.id]);
      let entry = entries.get(key);
      if (!entry) {
        entry = { revision: 0, pending: false };
        entries.set(key, entry);
      }
      const value = entry;
      const read = () => {
        void clock.state.revision;
        return value;
      };
      const set = (open: boolean): Promise<void> => {
        const revision = ++value.revision;
        value.intent = open;
        value.error = undefined;
        value.pending = !!save;
        const persist = async () => {
          try {
            await save?.(open);
          } catch (error) {
            if (value.revision === revision) value.error = error;
          } finally {
            if (value.revision === revision) value.pending = false;
            publish();
          }
        };
        const work = value.tail ? value.tail.then(persist) : persist();
        value.tail = work;
        publish();
        return work;
      };
      return {
        open: () => {
          const state = read(), saved = baseline();
          if (
            save && !state.pending && !state.error && state.intent === saved
          ) {
            state.intent = undefined;
          }
          return state.intent ?? saved;
        },
        pending: () => read().pending,
        error: () => read().error,
        set,
        retry: () => set(value.intent ?? baseline()),
      };
    },
  };
}
