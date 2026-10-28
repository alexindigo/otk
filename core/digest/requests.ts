// SPDX-License-Identifier: LGPL-3.0-only
import type { DigestScheduler } from "@otk/harness";
/** Worker-local request lifetimes. Finished/unknown cancellation is a no-op. */
export class DigestRequests {
  #active = new Map<
    number,
    { controller: AbortController; task: Promise<unknown> }
  >();
  #closed = false;
  #last = 0;
  constructor(
    readonly generation: string,
    readonly scheduler: DigestScheduler,
  ) {}
  run<T>(
    generation: string,
    id: number,
    read: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    if (
      this.#closed || generation !== this.generation ||
      !Number.isSafeInteger(id) || id <= this.#last
    ) return Promise.reject(new Error("Invalid digest request lifetime"));
    this.#last = id;
    const controller = new AbortController();
    const task = this.scheduler.execute(read, controller.signal).finally(() => {
      this.#active.delete(id);
    });
    this.#active.set(id, { controller, task });
    return task;
  }
  cancel(generation: string, id: number): void {
    if (generation === this.generation) {
      this.#active.get(id)?.controller.abort(
        new DOMException("Digest request cancelled", "AbortError"),
      );
    }
  }
  async stop(): Promise<void> {
    this.#closed = true;
    const active = [...this.#active.values()];
    for (const request of active) {
      request.controller.abort(
        new DOMException("Digest worker stopped", "AbortError"),
      );
    }
    await Promise.allSettled(active.map((request) => request.task));
  }
}
