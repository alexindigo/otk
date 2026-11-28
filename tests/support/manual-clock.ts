// SPDX-License-Identifier: LGPL-3.0-only
type Timer = { at: number; run: () => void; interval?: number };

export class ManualClock {
  #time = 0;
  #next = 0;
  #timers = new Map<number, Timer>();

  readonly now = () => this.#time;
  readonly set = (run: () => void, delay: number) => {
    const id = ++this.#next;
    this.#timers.set(id, { at: this.#time + delay, run });
    return id;
  };
  readonly clear = (id: unknown) => {
    if (typeof id === "number") this.#timers.delete(id);
  };

  /** Scope ambient timers to a synchronous unit test that has no clock input. */
  install(): Disposable {
    const saved = { setTimeout, clearTimeout, setInterval, clearInterval };
    globalThis.setTimeout =
      ((run: () => void, delay = 0) =>
        this.set(run, delay)) as typeof setTimeout;
    globalThis.setInterval = ((run: () => void, interval = 0) => {
      const id = this.set(run, Math.max(1, interval));
      this.#timers.get(id)!.interval = Math.max(1, interval);
      return id;
    }) as typeof setInterval;
    globalThis.clearTimeout = globalThis.clearInterval = this.clear;
    return { [Symbol.dispose]: () => Object.assign(globalThis, saved) };
  }

  get pending(): number {
    return this.#timers.size;
  }

  advanceTo(time: number): void {
    if (time < this.#time) throw new RangeError("Clock cannot run backwards");
    while (this.#runNext(time)) continue;
    this.#time = time;
  }

  /** Drive the scheduled owner's deadline without repeating its duration. */
  runNext(): void {
    if (!this.#runNext(Infinity)) throw new Error("No clock callback pending");
  }

  #runNext(limit: number): boolean {
    let next: [number, Timer] | undefined;
    for (const timer of this.#timers) {
      if (timer[1].at <= limit && (!next || timer[1].at < next[1].at)) {
        next = timer;
      }
    }
    if (!next) return false;
    const [id, timer] = next;
    this.#time = timer.at;
    if (timer.interval === undefined) this.#timers.delete(id);
    else timer.at += timer.interval;
    timer.run();
    return true;
  }
}
