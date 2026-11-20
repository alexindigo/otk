// SPDX-License-Identifier: LGPL-3.0-only
import type { ReceiptKey, RequestRecord } from "@otk/store";
import type { RequestRepository } from "./coordinator.ts";
import { ExecutionFailure } from "./failures.ts";
const key = (value: ReceiptKey) =>
  JSON.stringify([value.principal, value.client_id, value.intent_key]);
const active = (row: RequestRecord) =>
  ["queued", "running", "waiting", "reconciling"].includes(row.state);
/** Memory-only bootstrap receipts. No credential material reaches a database. */
export class VolatileRequests implements RequestRepository {
  #rows = new Map<string, RequestRecord>();
  #windows = new Map<string, { id: string; expires_at: number }>();
  constructor(readonly bootstrapExpiry: number) {
    this.#windows.set("bootstrap", {
      id: "bootstrap",
      expires_at: bootstrapExpiry,
    });
  }
  renewBootstrap(now: number, duration: number): void {
    this.#windows.set("bootstrap", {
      id: "bootstrap",
      expires_at: now + duration,
    });
  }
  get(input: ReceiptKey): RequestRecord | undefined {
    const value = this.#rows.get(key(input));
    return value ? structuredClone(value) : undefined;
  }
  /** Retained read metadata from an older durable owner; never mutation state. */
  retainWindow(window: { id: string; expires_at: number }): void {
    const previous = this.#windows.get(window.id);
    if (previous && previous.expires_at !== window.expires_at) {
      throw new Error("Request window conflict");
    }
    this.#windows.set(window.id, { ...window });
  }
  retain(
    record: RequestRecord,
    window?: { id: string; expires_at: number },
  ): void {
    if (record.execution !== "read" && record.execution !== "lease") {
      throw new TypeError("Only volatile request identities may be retained");
    }
    if (window) this.retainWindow(window);
    if (!this.#rows.has(key(record))) {
      this.#rows.set(key(record), structuredClone(record));
    }
  }
  admit(input: RequestRecord): { inserted: boolean; record: RequestRecord } {
    const old = this.get(input);
    if (old) {
      if (
        ["method", "window_id", "fingerprint", "execution"].some((name) =>
          old[name as keyof RequestRecord] !==
            input[name as keyof RequestRecord]
        )
      ) throw new Error("Request conflict");
      return { inserted: false, record: old };
    }
    const window = this.#windows.get(input.window_id);
    if (!window || window.expires_at <= input.accepted_at) {
      throw new ExecutionFailure({ code: "request.expired", retry: "none" });
    }
    this.#rows.set(key(input), structuredClone(input));
    return { inserted: true, record: structuredClone(input) };
  }
  transition(
    input: ReceiptKey,
    expectedSeq: number,
    patch: Partial<RequestRecord>,
  ): RequestRecord {
    const row = this.get(input);
    if (!row || row.seq !== expectedSeq || !active(row)) {
      throw new Error("Request sequence conflict");
    }
    const next = { ...row, ...patch, seq: row.seq + 1 };
    this.#rows.set(key(input), next);
    return structuredClone(next);
  }
  activeCount(principal: string): number {
    return [...this.#rows.values()].filter((row) =>
      row.principal === principal && active(row)
    ).length;
  }
  inFlight(after: ReceiptKey | undefined, limit: number): RequestRecord[] {
    return [...this.#rows.values()].filter((row) =>
      active(row) && (!after || key(row) > key(after))
    ).sort((a, b) => key(a).localeCompare(key(b))).slice(0, limit).map((row) =>
      structuredClone(row)
    );
  }
  sweep(now: number, limit: number): number {
    let removed = 0;
    for (const [id, row] of this.#rows) {
      if (removed < limit && !active(row) && row.retention_until <= now) {
        this.#rows.delete(id);
        removed++;
      }
    }
    let windows = 0;
    for (const [id, window] of this.#windows) {
      if (windows >= limit) break;
      if (
        id !== "bootstrap" && window.expires_at <= now &&
        ![...this.#rows.values()].some((row) => row.window_id === id)
      ) {
        this.#windows.delete(id);
        windows++;
      }
    }
    return removed;
  }
  windowInfo(id: string): { id: string; expires_at: number } | undefined {
    return this.#windows.get(id);
  }
  window(now: number, duration: number): { id: string; expires_at: number } {
    const window = { id: crypto.randomUUID(), expires_at: now + duration };
    this.#windows.set(window.id, window);
    return window;
  }
}
