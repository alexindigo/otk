// SPDX-License-Identifier: LGPL-3.0-only
import type { OtkDb } from "./db.ts";

/** Post-commit delivery is independent of mutation success and other observers. */
export class Changes<T> {
  #listeners = new Set<(value: T) => void>();
  #report: (error: unknown) => void;
  constructor(db: OtkDb) {
    this.#report = (error) => db.observerError(error);
  }
  listen(listener: (value: T) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }
  protected changed(value: T): void {
    for (const listener of [...this.#listeners]) {
      try {
        listener(structuredClone(value));
      } catch (error) {
        try {
          this.#report(error);
        } catch (reportError) {
          console.error(
            "Store observer reporting failed",
            new AggregateError([
              error,
              reportError,
            ]),
          );
        }
      }
    }
  }
}
