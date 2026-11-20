// SPDX-License-Identifier: LGPL-3.0-only
type Refresh = { run(current: () => boolean): Promise<void>; at: number };
/** Native refresh coordination, like DeliveryJoin: publications stay cheap;
 * only the newest work for a key may publish. Reads retain existing admission.
 * One generation owns and joins all refreshes, including cancellation. */
export class EventRefresh {
  #pending = new Map<string, Refresh>();
  #latest = new Map<string, Refresh>();
  #controller = new AbortController();
  readonly signal: AbortSignal;
  #task?: Promise<void>;
  #active?: string;
  constructor(signal: AbortSignal, readonly failed: (error: unknown) => void) {
    this.signal = AbortSignal.any([signal, this.#controller.signal]);
  }
  request(key: string, run: Refresh["run"]): void {
    if (this.signal.aborted) return;
    const work = { run, at: this.#latest.get(key)?.at ?? Date.now() };
    this.#latest.set(key, work);
    this.#pending.set(key, work);
    if (!this.#task) this.#start();
  }
  forget(key: string): void {
    this.#latest.delete(key);
    this.#pending.delete(key);
  }
  get pressure() {
    return {
      pending: this.#pending.size,
      active: this.#active,
      oldestAgeMs: this.#latest.size
        ? Date.now() -
          Math.min(...[...this.#latest.values()].map((work) => work.at))
        : 0,
    };
  }
  #start(): void {
    this.#task = (async () => {
      // Yield a real event-loop turn so a native burst collapses before I/O.
      await new Promise<void>((resolve) => {
        const done = () => {
          clearTimeout(timer);
          this.signal.removeEventListener("abort", done);
          resolve();
        };
        const timer = setTimeout(done, 0);
        this.signal.addEventListener("abort", done, { once: true });
        if (this.signal.aborted) done();
      });
      while (this.#pending.size && !this.signal.aborted) {
        const [key, work] = this.#pending.entries().next().value!;
        this.#pending.delete(key);
        this.#active = key;
        const current = () =>
          !this.signal.aborted && this.#latest.get(key) === work;
        await work.run(current);
        if (current()) this.#latest.delete(key);
        this.#active = undefined;
      }
    })().catch((error) => {
      if (!this.signal.aborted) this.failed(error);
    }).finally(() => {
      this.#active = undefined;
      this.#task = undefined;
      if (!this.signal.aborted && this.#pending.size) this.#start();
    });
  }
  cancel(): void {
    this.#controller.abort();
    this.#pending.clear();
    this.#latest.clear();
  }
  async stop(): Promise<void> {
    this.cancel();
    await this.#task;
  }
}
