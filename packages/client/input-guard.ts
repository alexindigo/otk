// SPDX-License-Identifier: LGPL-3.0-only
import type { Drafts } from "./drafts.ts";

export interface ReleaseInput {
  /** Stored drafts survive ordinary navigation; destructive releases say otherwise. */
  draft: "kept" | "dropped";
  /** Captured draft identities being released; defaults to the current session. */
  keys?: readonly string[];
}

export interface InputGuard {
  mark(owner: string, dirty: boolean, input?: string): void;
  retained(): { owner: string; value: string }[];
  dirty(owner: string): boolean;
  clear(): void;
  release(input?: ReleaseInput): boolean;
  permit(owner: string, message: string): boolean;
}
export interface InputRetention {
  /** These owners are authoritative even when their canonical input is empty. */
  owners: readonly string[];
  inputs: { owner: string; value: string }[];
  discard(): void;
}
export function createInputGuard(
  o: {
    drafts: Drafts;
    key(): string;
    confirm(message: string): boolean;
    retain?(): boolean;
    /** Retained request drafts belong to their lifecycle, not mounted inputs. */
    retention?(): InputRetention | undefined;
  },
): InputGuard {
  const dirty = new Map<string, boolean>();
  const inputs = new Map<string, string>();
  let accepted: InputRetention | undefined;
  const isDirty = (owner: string, retention = o.retention?.()) =>
    retention?.owners.includes(owner)
      ? retention.inputs.some((input) => input.owner === owner)
      : !!dirty.get(owner);
  const retained = () => {
    const retention = o.retention?.();
    const values = new Map(
      [...inputs].filter(([owner]) =>
        dirty.get(owner) && !retention?.owners.includes(owner)
      ),
    );
    for (const input of retention?.inputs ?? []) {
      values.set(input.owner, input.value);
    }
    return [...values].map(([owner, value]) => ({ owner, value }));
  };
  return {
    mark(owner, value, input) {
      if (!value && dirty.get(owner) && o.retain?.()) return;
      dirty.set(owner, value);
      if (input !== undefined) inputs.set(owner, input);
      if (!value) inputs.delete(owner);
    },
    retained,
    dirty: (owner) => isDirty(owner),
    clear() {
      dirty.clear();
      inputs.clear();
      accepted?.discard();
      accepted = undefined;
    },
    release(input = { draft: "kept" }) {
      // Frameworks can batch painted reads during input events. The plain
      // current read never creates a draft while checking what would be lost.
      const key = o.key(), keys = input.keys ?? [key];
      const drafts = keys.map((key) => o.drafts.current(key));
      // Stored attachments survive mode switches, even when the current mode
      // would not submit them. Losing a draft is distinct from sendability.
      const losesDraft = input.draft === "dropped" &&
        drafts.some((draft) => !!draft.input.trim() || draft.chips.length > 0);
      const retention = o.retention?.();
      const losesInput = drafts.some((draft) => !!draft.editor) ||
        (keys.includes(key) &&
          ([...dirty.keys()].some((owner) => isDirty(owner, retention)) ||
            !!retention?.inputs.length));
      if (!losesDraft && !losesInput) return true;
      if (
        !o.confirm(
          losesDraft
            ? "Discard unsent draft and unsaved input before continuing?"
            : "Discard unsaved editor or attention input before switching sessions?",
        )
      ) return false;
      // Clear only after the caller confirms the captured transition succeeded.
      accepted = keys.includes(key) ? retention : undefined;
      // A destructive mutation may still fail. Its caller drops drafts only
      // after success; consent alone never consumes the draft or its editor.
      if (input.draft === "kept") {
        for (const key of keys) {
          o.drafts.writer(key)((value) =>
            value.editor ? { ...value, editor: undefined } : value
          );
        }
      }
      return true;
    },
    permit: (owner, message) => !isDirty(owner) || o.confirm(message),
  };
}
