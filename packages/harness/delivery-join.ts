// SPDX-License-Identifier: LGPL-3.0-only
import type { DeliveredEvidence } from "@otk/protocol";
import type { ProviderReadPort } from "./provider-reads.ts";

/** Joins the digest store's durable child/run delivery facts onto published
 * metadata. It holds only IDs awaiting a read, never facts: the store stays the
 * sole authority, and an adapter resync or refresh has nothing here to erase.
 * Publication itself stays synchronous; each settled read reports the store's
 * current fact, or its absence, for the adapter to apply to its latest entry. */
export class DeliveryJoin {
  #pending = new Set<string>();
  #task?: Promise<void>;
  #controller = new AbortController();
  readonly owner = `delivery-join:${crypto.randomUUID()}`;
  constructor(
    readonly port: ProviderReadPort,
    readonly apply: (id: string, fact: DeliveredEvidence | undefined) => void,
    readonly diagnostic: (error: unknown) => void,
    readonly rows = 200,
  ) {}
  request(ids: Iterable<string>): void {
    if (this.#controller.signal.aborted) return;
    for (const id of ids) this.#pending.add(id);
    if (this.#pending.size) this.#start();
  }
  #start(): void {
    if (this.#task) return;
    let failed = false;
    this.#task = Promise.resolve().then(() => this.#drain()).catch((error) => {
      failed = true;
      if (!this.#controller.signal.aborted) this.diagnostic(error);
    }).finally(() => {
      this.#task = undefined;
      // A failed read leaves published facts in place; the next request retries.
      if (!failed && this.#pending.size) this.#start();
    });
  }
  async #drain(): Promise<void> {
    const signal = this.#controller.signal;
    while (this.#pending.size && !signal.aborted) {
      const batch = [...this.#pending].slice(0, this.rows);
      for (const id of batch) this.#pending.delete(id);
      let facts: Map<string, DeliveredEvidence>;
      try {
        facts = new Map(
          (await this.port.read("supervision.delivered", { ids: batch }, {
            owner: this.owner,
            priority: "attention",
            signal,
          })).map((fact) => [fact.id, fact.delivered]),
        );
      } catch (error) {
        for (const id of batch) this.#pending.add(id);
        throw error;
      }
      signal.throwIfAborted();
      for (const id of batch) {
        // A newer request re-reads; an older answer never overrides it.
        if (!this.#pending.has(id)) this.apply(id, facts.get(id));
      }
    }
  }
  async settle(): Promise<void> {
    while (this.#task) await this.#task;
  }
  async stop(): Promise<void> {
    this.#controller.abort();
    this.#pending.clear();
    this.port.release(this.owner);
    await this.#task;
  }
}
