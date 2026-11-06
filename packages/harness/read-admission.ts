// SPDX-License-Identifier: LGPL-3.0-only
interface Waiting {
  essential: boolean;
  preempt?: () => void;
  signal: AbortSignal;
  resolve(release: () => void): void;
  reject(error: unknown): void;
  cancel(): void;
}
/** I/O permission is distinct from executing work in the shared scheduler. */
export class ReadAdmission {
  #active = new Set<{ essential: boolean; preempt?: () => void }>();
  #waiting: Waiting[] = [];
  constructor(readonly preempt?: () => void, readonly maximum = 1) {
    if (!Number.isSafeInteger(maximum) || maximum <= 0) {
      throw new TypeError("Invalid read admission limit");
    }
  }
  get optionalActive(): number {
    return [...this.#active].filter((value) => !value.essential).length;
  }
  acquire(
    signal: AbortSignal,
    essential: boolean,
    preempt?: () => void,
  ): Promise<() => void> {
    if (signal.aborted) return Promise.reject(signal.reason);
    return new Promise((resolve, reject) => {
      const request: Waiting = {
        essential,
        preempt,
        signal,
        resolve,
        reject,
        cancel: () => {
          const index = this.#waiting.indexOf(request);
          if (index >= 0) this.#waiting.splice(index, 1);
          reject(signal.reason);
        },
      };
      signal.addEventListener("abort", request.cancel, { once: true });
      this.#waiting.push(request);
      if (
        essential && this.#active.size >= this.maximum &&
        [...this.#active].some((value) => !value.essential)
      ) {
        for (const active of this.#active) {
          if (!active.essential) (active.preempt ?? this.preempt)?.();
        }
      }
      this.#pump();
    });
  }
  #pump(): void {
    while (this.#active.size < this.maximum && this.#waiting.length) {
      const priority = this.#waiting.findIndex((request) => request.essential);
      const [request] = this.#waiting.splice(priority < 0 ? 0 : priority, 1);
      request.signal.removeEventListener("abort", request.cancel);
      if (request.signal.aborted) {
        request.reject(request.signal.reason);
        continue;
      }
      const active = { essential: request.essential, preempt: request.preempt };
      this.#active.add(active);
      request.resolve(() => {
        if (this.#active.delete(active)) this.#pump();
      });
    }
  }
}
