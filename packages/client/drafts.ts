// SPDX-License-Identifier: LGPL-3.0-only
import type { PromptPart } from "@otk/protocol";
import { createState, type StateFactory } from "./state.ts";

export interface Chip {
  id: string;
  label: string;
  start: number;
  end: number;
  part: PromptPart;
  pending?: boolean;
  error?: string;
}
export interface Draft {
  input: string;
  chips: Chip[];
  mode: "normal" | "shell";
  agent?: string;
  editor?: { text: string; chipID?: string };
}
export type DraftChange = Draft | ((current: Draft) => Draft);
export const emptyDraft = (): Draft => ({
  input: "",
  chips: [],
  mode: "normal",
});

/** Browser-lifetime drafts, keyed by server and session, never session content. */
export interface Drafts {
  get(key: string): Draft;
  writer(key: string): (change: DraftChange) => Draft;
  subscribe(listener: () => void): () => void;
}
export function createDrafts(factory: StateFactory = createState): Drafts {
  const values = new Map<string, Draft>();
  const store = factory({ revision: 0 });
  const get = (key: string): Draft => {
    void store.state.revision;
    return values.get(key) ?? emptyDraft();
  };
  const writer = (key: string) => (change: DraftChange): Draft => {
    const current = values.get(key) ?? emptyDraft();
    const next = typeof change === "function" ? change(current) : change;
    values.set(key, next);
    if (next !== current) {
      store.update((state) => {
        state.revision++;
      });
    }
    return next;
  };
  return { get, writer, subscribe: store.subscribe };
}
