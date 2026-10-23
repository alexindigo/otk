// SPDX-License-Identifier: LGPL-3.0-only
import type { ModelRef, PromptPart } from "@otk/protocol";
import { createState, type StateFactory } from "./state.ts";

export interface Chip {
  id: string;
  label: string;
  /** Paired coordinates for an inline token; absent for independent attachments. */
  start?: number;
  end?: number;
  part: PromptPart;
  pending?: boolean;
  error?: string;
}
export interface Draft {
  input: string;
  chips: Chip[];
  mode: "normal" | "shell";
  agent?: string;
  model?: ModelRef;
  /** Missing means inherit; an own undefined value means explicitly Default. */
  variant?: string;
  editor?: { text: string; chipID?: string };
}
export type DraftChange = Draft | ((current: Draft) => Draft);
export const emptyDraft = (): Draft => ({
  input: "",
  chips: [],
  mode: "normal",
});

/** Replace content without taking ownership of this draft's prompt choices. */
export function replaceDraftContent(
  draft: Draft,
  content: Pick<Draft, "input" | "chips" | "mode">,
): Draft {
  const next = {
    ...draft,
    input: content.input,
    chips: content.chips,
    mode: content.mode,
  };
  delete next.editor;
  return next;
}

/** Clear submitted content while retaining explicit next-prompt choices. */
export function clearDraft(draft: Draft): Draft {
  return replaceDraftContent(draft, emptyDraft());
}

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
