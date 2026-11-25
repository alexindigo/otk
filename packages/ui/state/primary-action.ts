// SPDX-License-Identifier: LGPL-3.0-only
import { createSignal, onCleanup } from "solid-js";
/** Observe admission without copying the owner's state or draft. */
export function bindPrimaryAction<S>(owner: {
  readonly state: S;
  subscribe(listener: () => void): () => void;
}): () => S {
  const [revision, update] = createSignal(0);
  onCleanup(owner.subscribe(() => update((value) => value + 1)));
  return () => {
    revision();
    return owner.state;
  };
}
