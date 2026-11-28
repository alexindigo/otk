// SPDX-License-Identifier: LGPL-3.0-only
import { createEffect, onCleanup } from "solid-js";

/** The guard borrows committed draft state only while its input is mounted. */
export function bindDirtyInput(
  read: () => { dirty: boolean; text?: string },
  notify: (dirty: boolean, text?: string) => void,
): void {
  createEffect(read, (value) => {
    notify(value.dirty, value.text);
  });
  onCleanup(() => notify(false));
}
