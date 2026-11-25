// SPDX-License-Identifier: LGPL-3.0-only
export type NativeReadLane = "interactive" | "bulk" | "control";
interface Waiting {
  essential: boolean;
  lane: NativeReadLane;
  preempt?: () => void;
  signal: AbortSignal;
  resolve(release: () => void): void;
  reject(error: unknown): void;
  cancel(): void;
}
/** I/O permission is distinct from executing work in the shared scheduler. */
export class ReadAdmission {
  #active = new Set<{
    essential: boolean;
    lane: NativeReadLane;
    preempt?: () => void;
  }>();
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
    lane: NativeReadLane = "interactive",
  ): Promise<() => void> {
    if (signal.aborted) return Promise.reject(signal.reason);
    return new Promise((resolve, reject) => {
      const request: Waiting = {
        essential,
        lane,
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
      const peers = [...this.#active].filter((value) => value.lane === lane);
      if (essential && peers.length >= this.#capacity(lane)) {
        for (const peer of peers) {
          if (!peer.essential) (peer.preempt ?? this.preempt)?.();
        }
      }
      this.#pump();
    });
  }
  #capacity(lane: NativeReadLane): number {
    return lane === "interactive" ? this.maximum : 1;
  }
  #pump(): void {
    while (this.#waiting.length) {
      const fits = (request: Waiting) =>
        [...this.#active].filter((read) => read.lane === request.lane).length <
          this.#capacity(request.lane);
      const priority = this.#waiting.findIndex((r) => r.essential && fits(r));
      const next = priority < 0 ? this.#waiting.findIndex(fits) : priority;
      if (next < 0) break;
      const [request] = this.#waiting.splice(next, 1);
      request.signal.removeEventListener("abort", request.cancel);
      if (request.signal.aborted) {
        request.reject(request.signal.reason);
        continue;
      }
      const active = {
        essential: request.essential,
        lane: request.lane,
        preempt: request.preempt,
      };
      this.#active.add(active);
      request.resolve(() => {
        if (this.#active.delete(active)) this.#pump();
      });
    }
  }
}
