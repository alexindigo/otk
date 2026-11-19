// SPDX-License-Identifier: LGPL-3.0-only
import type { StorageAvailability } from "@otk/store";
import type { ServerFrame, StorageState } from "@otk/protocol";
import type { FrameSource } from "../ws/connections.ts";
import { storageFailure } from "../requests/failures.ts";

/** Memory-only publication: disk failure must never depend on another disk write. */
export class StorageFeature implements FrameSource {
  #listeners = new Set<(frame: ServerFrame) => void>();
  #stop: () => void;
  #timer: ReturnType<typeof setInterval>;
  #state: StorageState;
  constructor(
    readonly owner: StorageAvailability,
    retryms: number,
    recovered: () => void = () => {},
  ) {
    const state = (): StorageState => {
      const status = owner.status();
      return {
        ...status,
        ...(status.degraded
          ? {
            failure: storageFailure(
              status.problem ?? "io",
              `storage-${status.gap}`,
            ),
          }
          : {}),
      };
    };
    this.#state = state();
    this.#stop = owner.listen(() => {
      const previous = this.#state;
      this.#state = state();
      for (const listener of this.#listeners) {
        try {
          listener(this.snapshot());
        } catch (error) {
          console.error("Storage notice delivery failed", error);
        }
      }
      if (previous.degraded && !this.#state.degraded) recovered();
    });
    this.#timer = setInterval(() => {
      if (owner.status().degraded) owner.probe();
    }, retryms);
  }
  snapshot(): ServerFrame {
    return { t: "storage", state: this.#state };
  }
  listen(listener: (frame: ServerFrame) => void): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }
  close(): void {
    clearInterval(this.#timer);
    this.#stop();
    this.#listeners.clear();
  }
}
