// SPDX-License-Identifier: LGPL-3.0-only
import type {
  ReceiptKey,
  RequestRecord,
  Requests,
  StoreWrite,
} from "@otk/store";
import { storageProblem } from "@otk/store";
import type { RequestRepository } from "./coordinator.ts";
import { VolatileRequests } from "./volatile.ts";

/** Reloadable reads have volatile receipts; mutations never fall back to memory. */
export class StorageRequests implements RequestRepository {
  readonly reads = new VolatileRequests(0);
  constructor(readonly durable: Requests) {}
  window(now: number, duration: number) {
    return this.reads.window(now, duration);
  }
  windowInfo(id: string) {
    return this.reads.windowInfo(id) ?? this.durable.windowInfo(id);
  }
  get(key: ReceiptKey) {
    const known = this.reads.get(key);
    if (known) return known;
    const old = this.durable.get(key);
    if (old && (old.execution === "read" || old.execution === "lease")) {
      this.reads.retain(old, this.durable.windowInfo(old.window_id));
    }
    return old;
  }
  admit(record: RequestRecord, tx?: StoreWrite) {
    if (record.execution === "read" || record.execution === "lease") {
      // Lookup and admission borrow the same validated server authority. After
      // restart a mutation's durable window must not disappear only for reads.
      const window = this.windowInfo(record.window_id);
      if (window) this.reads.retainWindow(window);
      return this.reads.admit(record);
    }
    // Storage owns window/receipt atomicity; the coordinator knows no SQL schema.
    return this.durable.admit(
      record,
      tx,
      this.reads.windowInfo(record.window_id),
    );
  }
  transition(
    key: ReceiptKey,
    seq: number,
    patch: Partial<RequestRecord>,
    tx?: StoreWrite,
  ) {
    return this.reads.get(key)
      ? this.reads.transition(key, seq, patch)
      : this.durable.transition(key, seq, patch, tx);
  }
  activeCount(principal: string) {
    return this.reads.activeCount(principal) +
      this.durable.activeCount(principal, true);
  }
  inFlight(after: ReceiptKey | undefined, limit: number) {
    return this.durable.inFlight(after, limit).map((record) =>
      this.get(record)!
    );
  }
  sweep(now: number, limit: number): number {
    const removed = this.reads.sweep(now, limit);
    try {
      return removed + this.durable.sweep(now, limit);
    } catch (error) {
      if (!storageProblem(error)) throw error;
      return removed;
    }
  }
}
