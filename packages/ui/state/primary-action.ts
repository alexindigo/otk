// SPDX-License-Identifier: LGPL-3.0-only
import { createSignal, onCleanup } from "solid-js";
import type { PrimaryAction, PrimaryActionState } from "@otk/client";

/** Observe admission without copying the owner's state or draft. */
export function bindPrimaryAction<T>(
  owner: PrimaryAction<T>,
): () => PrimaryActionState {
  const [revision, update] = createSignal(0);
  onCleanup(owner.subscribe(() => update((value) => value + 1)));
  return () => {
    revision();
    return owner.state;
  };
}
