// SPDX-License-Identifier: LGPL-3.0-only
import type { DeliveredEvidence } from "@otk/protocol";
import type { ProviderReadPort } from "./provider-reads.ts";

/** Metadata-only, coalesced parent work. Native codecs and durable cursors stay
 * in the selected worker plugin. No browser/content demand is involved. */
export class DeliveryBackfill {
  #pending = new Set<string>();
  #refresh = new Set<string>();
  #task?: Promise<void>;
  #controller = new AbortController();
  constructor(
    readonly port: ProviderReadPort,
    readonly publish: (
      parent: string,
      updates: readonly { id: string; delivered: DeliveredEvidence }[],
      reset: boolean,
    ) => void,
    readonly diagnostic: (error: unknown) => void,
  ) {}
  request(parentID: string, refresh = false): void {
    if (this.#controller.signal.aborted) return;
    this.#pending.add(parentID);
    if (refresh) this.#refresh.add(parentID);
    this.#task ??= this.#drain().finally(() => {
      this.#task = undefined;
    });
  }
  async #drain(): Promise<void> {
    while (this.#pending.size && !this.#controller.signal.aborted) {
      const parentID = this.#pending.values().next().value!;
      this.#pending.delete(parentID);
      const refresh = this.#refresh.delete(parentID);
      let after: string | undefined;
      try {
        do {
          const page = await this.port.read("supervision.deliveries", {
            parentID,
            after,
            refresh: after === undefined && refresh,
          }, {
            owner: "supervision-delivery",
            priority: "background",
            signal: this.#controller.signal,
          });
          this.#controller.signal.throwIfAborted();
          this.publish(parentID, page.updates, page.reset === true);
          after = page.after;
          // Every chunk relinquishes its worker turn and publication credit.
          await new Promise<void>((resolve) => setTimeout(resolve, 0));
        } while (after !== undefined);
      } catch (error) {
        if (!this.#controller.signal.aborted) this.diagnostic(error);
      }
    }
  }
  async stop(): Promise<void> {
    this.#controller.abort();
    this.#pending.clear();
    this.port.release("supervision-delivery");
    await this.#task;
  }
}
