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
  /** Invocation-current, non-creating read without framework publication tracking. */
  current(key: string): Draft;
  writer(key: string): (change: DraftChange) => Draft;
  drop(key: string): void;
  subscribe(listener: () => void): () => void;
}
export function createDrafts(factory: StateFactory = createState): Drafts {
  const values = new Map<string, { draft: Draft }>();
  const store = factory({ revision: 0 });
  const current = (key: string) => values.get(key)?.draft ?? emptyDraft();
  const get = (key: string): Draft => {
    void store.state.revision;
    return current(key);
  };
  const changed = () =>
    store.update((state) => {
      state.revision++;
    });
  const writer = (key: string) => {
    let owner = values.get(key);
    if (!owner) {
      owner = { draft: emptyDraft() };
      values.set(key, owner);
    }
    const captured = owner;
    return (change: DraftChange): Draft => {
      if (values.get(key) !== captured) return current(key);
      const previous = captured.draft;
      const next = typeof change === "function" ? change(previous) : change;
      captured.draft = next;
      if (next !== previous) changed();
      return next;
    };
  };
  return {
    get,
    current,
    writer,
    drop(key) {
      if (values.delete(key)) changed();
    },
    subscribe: store.subscribe,
  };
}
