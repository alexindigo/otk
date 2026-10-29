// SPDX-License-Identifier: LGPL-3.0-only
interface Waiting {
  essential: boolean;
  signal: AbortSignal;
  resolve(release: () => void): void;
  reject(error: unknown): void;
  cancel(): void;
}
/** Native I/O keeps its serial admission without occupying a scheduler turn. */
export class DigestReadGate {
  #active: { essential: boolean } | undefined;
  #waiting: Waiting[] = [];
  constructor(readonly preempt?: () => void) {}
  acquire(signal: AbortSignal, essential: boolean): Promise<() => void> {
    if (signal.aborted) return Promise.reject(signal.reason);
    return new Promise((resolve, reject) => {
      const request: Waiting = {
        essential,
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
      if (essential && this.#active && !this.#active.essential) {
        this.preempt?.();
      }
      this.#pump();
    });
  }
  #pump(): void {
    if (this.#active || !this.#waiting.length) return;
    const priority = this.#waiting.findIndex((request) => request.essential);
    const [request] = this.#waiting.splice(priority < 0 ? 0 : priority, 1);
    request.signal.removeEventListener("abort", request.cancel);
    if (request.signal.aborted) {
      request.reject(request.signal.reason);
      this.#pump();
      return;
    }
    this.#active = { essential: request.essential };
    let released = false;
    request.resolve(() => {
      if (released) return;
      released = true;
      this.#active = undefined;
      this.#pump();
    });
  }
}
