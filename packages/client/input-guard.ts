// SPDX-License-Identifier: LGPL-3.0-only
import type { Drafts } from "./drafts.ts";

export interface ReleaseInput {
  /** Stored drafts survive ordinary navigation; destructive releases say otherwise. */
  draft: "kept" | "dropped";
  /** Captured draft identities being released; defaults to the current session. */
  keys?: readonly string[];
  /** A deleted view can lose request input while keeping its stored draft. */
  retainedOnly?: boolean;
  message?: string;
}

export interface InputGuard {
  mark(owner: string, dirty: boolean, input?: string): void;
  retained(): { owner: string; value: string }[];
  dirty(owner: string): boolean;
  clear(): void;
  release(input?: ReleaseInput & { draft: "kept" }): true;
  release(
    input: ReleaseInput & { draft: "dropped" },
  ): Promise<false | (() => void)>;
  permit(owner: string, message: string): boolean | Promise<boolean>;
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
    confirm(message: string): boolean | Promise<boolean>;
    retain?(): boolean;
    /** Retained request drafts belong to their lifecycle, not mounted inputs. */
    retention?(): InputRetention | undefined;
  },
): InputGuard {
  const dirty = new Map<string, boolean>();
  const inputs = new Map<string, string>();
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
  function release(input?: ReleaseInput & { draft: "kept" }): true;
  function release(
    input: ReleaseInput & { draft: "dropped" },
  ): Promise<false | (() => void)>;
  function release(
    input: ReleaseInput = { draft: "kept" },
  ): true | Promise<false | (() => void)> {
    if (input.draft === "kept") return true;
    // Read only what the pending mutation can actually remove. Neither consent
    // nor navigation consumes this captured draft; only committed deletion does.
    const key = o.key(), keys = input.keys ?? [key];
    const retention = keys.includes(key) ? o.retention?.() : undefined;
    const losesDraft = !input.retainedOnly && keys.some((key) => {
      const draft = o.drafts.current(key);
      return !!draft.input.trim() || draft.chips.length > 0 || !!draft.editor;
    });
    const losesInput = keys.includes(key) &&
      ([...dirty.keys()].some((owner) => isDirty(owner, retention)) ||
        !!retention?.inputs.length);
    return (async () => {
      if (
        (losesDraft || losesInput) && !await o.confirm(
          input.message ??
            "Discard your unsent input for the sessions being deleted?",
        )
      ) return false;
      return () => retention?.discard();
    })();
  }
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
    },
    release,
    permit: (owner, message) => !isDirty(owner) || o.confirm(message),
  };
}
