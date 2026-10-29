// SPDX-License-Identifier: LGPL-3.0-only
import type { DigestWorkerValue } from "./protocol.ts";

/** One credited packet in flight plus one bounded packet being filled. */
export class DigestBatch {
  #values: DigestWorkerValue[] = [];
  #rows = 0;
  #inflight?: Promise<void>;
  #failure?: { error: unknown };
  #appended = 0;
  #published = 0;
  constructor(
    readonly options: {
      rows: number;
      signal: AbortSignal;
      wait<T>(readiness: Promise<T>): Promise<T>;
      schedule(write: () => Promise<void>): Promise<void>;
      send(values: DigestWorkerValue[]): Promise<void>;
    },
  ) {}
  async append(value: DigestWorkerValue, signal: AbortSignal): Promise<void> {
    const rows = Math.max(
      1,
      Object.keys(value.delta.turns.upsert).length +
        value.delta.turns.remove.length,
    );
    if (rows > this.options.rows) {
      throw new Error("Digest publication exceeds its row budget");
    }
    while (this.#rows + rows > this.options.rows) {
      signal.throwIfAborted();
      if (this.#failure) throw this.#failure.error;
      this.flush();
      await this.options.wait(this.#inflight!);
    }
    signal.throwIfAborted();
    if (this.#failure) throw this.#failure.error;
    this.#values.push(structuredClone(value));
    this.#rows += rows;
    this.#appended++;
    if (this.#rows === this.options.rows) this.flush();
  }
  /** Full packets flush immediately; the dispatcher also flushes partial idle packets. */
  flush(): boolean {
    if (
      this.#inflight || !this.#values.length || this.options.signal.aborted ||
      this.#failure
    ) return false;
    const values = this.#values;
    this.#values = [];
    this.#rows = 0;
    const flight = this.options.schedule(async () => {
      await this.options.send(values);
      this.#published += values.length;
    }).catch(
      (error) => {
        this.#failure = { error };
        throw error;
      },
    ).finally(() => {
      if (this.#inflight === flight) this.#inflight = undefined;
      if (this.#rows === this.options.rows) this.flush();
    });
    this.#inflight = flight;
    void flight.catch(() => {}); // Failure is retained and propagated to producers/close.
    return true;
  }
  /** Publication fence for a completed producer, independent of later producers. */
  async settle(signal: AbortSignal): Promise<void> {
    const through = this.#appended;
    while (this.#published < through) {
      signal.throwIfAborted();
      this.options.signal.throwIfAborted();
      if (this.#failure) throw this.#failure.error;
      this.flush();
      await this.options.wait(this.#inflight!);
    }
    signal.throwIfAborted();
  }
  async close(): Promise<void> {
    while (
      !this.options.signal.aborted && (this.#values.length || this.#inflight)
    ) {
      if (this.#failure) throw this.#failure.error;
      this.flush();
      if (this.#inflight) await this.options.wait(this.#inflight);
    }
    this.#values = [];
    this.#rows = 0;
    await this.#inflight?.catch((error) => {
      if (!this.options.signal.aborted) throw error;
    });
    if (this.#failure && !this.options.signal.aborted) {
      throw this.#failure.error;
    }
  }
}
