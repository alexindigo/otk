// SPDX-License-Identifier: LGPL-3.0-only
import { createState, type StateFactory } from "./state.ts";

/** Pill presence for a composer activity popover. Zero while closed hides the
 * pill (D67/D72); zero while open retains it for deliberate dismissal. */
export class ActivityPresence {
  #store;

  constructor(factory: StateFactory = createState) {
    this.#store = factory({ populated: false, open: false });
  }

  get mounted(): boolean {
    const { populated, open } = this.#store.state;
    return populated || open;
  }

  get retiring(): boolean {
    const { populated, open } = this.#store.state;
    return open && !populated;
  }

  publish(count: number): void {
    this.#store.update((state) => state.populated = count > 0);
  }

  opened(): void {
    this.#store.update((state) => state.open = true);
  }

  closed(): void {
    this.#store.update((state) => state.open = false);
  }
}
