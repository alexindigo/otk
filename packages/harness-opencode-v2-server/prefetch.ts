// SPDX-License-Identifier: LGPL-3.0-only
import type { PrefetchPage } from "./transcript-reads.ts";
/** Aggregate FIFO. Complete encoded key/payload bytes, insertion TTL, no disk. */
export class MessagePrefetchCache {
  #entries = new Map<
    string,
    { session: string; at: number; bytes: Uint8Array; size: number }
  >();
  #bytes = 0;
  constructor(
    readonly policy: { prefetchms: number; prefetchbytes: number },
    readonly now: () => number = () => performance.now(),
  ) {}
  #remove(key: string): void {
    const value = this.#entries.get(key);
    if (value) {
      this.#bytes -= value.size;
      this.#entries.delete(key);
    }
  }
  #expire(): void {
    for (const [key, value] of this.#entries) {
      if (this.now() - value.at >= this.policy.prefetchms) this.#remove(key);
    }
  }
  get bytes(): number {
    this.#expire();
    return this.#bytes;
  }
  get(key: string): PrefetchPage | undefined {
    this.#expire();
    const v = this.#entries.get(key);
    return v && JSON.parse(new TextDecoder().decode(v.bytes));
  }
  put(session: string, key: string, value: PrefetchPage): void {
    this.#expire();
    this.#remove(key);
    const bytes = new TextEncoder().encode(JSON.stringify(value));
    const size = bytes.length +
      new TextEncoder().encode(JSON.stringify([session, key])).length;
    if (size > this.policy.prefetchbytes) return;
    while (this.#bytes + size > this.policy.prefetchbytes) {
      this.#remove(this.#entries.keys().next().value!);
    }
    this.#entries.set(key, { session, at: this.now(), bytes, size });
    this.#bytes += size;
  }
  clear(session?: string): void {
    for (const [key, value] of this.#entries) {
      if (session === undefined || value.session === session) this.#remove(key);
    }
  }
}
