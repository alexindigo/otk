// SPDX-License-Identifier: LGPL-3.0-only
import type { ProviderReadCodec, TranscriptMetadata } from "@otk/harness";
import type { Messages } from "./messages.ts";

export interface PrefetchInput {
  sessionID: string;
  directory: string;
  before: string;
  limit: number;
  cutoff?: string;
}
export interface PrefetchPage {
  page: Awaited<ReturnType<Messages["page"]>>;
  metadata?: TranscriptMetadata;
}
declare module "@otk/harness" {
  interface ProviderReadKinds {
    "opcv1.message.prefetch": {
      input: PrefetchInput;
      result: PrefetchPage;
      chunk: string;
    };
  }
}
/** Byte-bounded transient fragments, never a durable digest publication. */
export const messagePrefetchCodec: ProviderReadCodec<"opcv1.message.prefetch"> =
  {
    *chunks(value) {
      const bytes = new TextEncoder().encode(JSON.stringify(value));
      for (let at = 0; at < bytes.length; at += 32768) {
        yield btoa(String.fromCharCode(...bytes.subarray(at, at + 32768)));
      }
    },
    create() {
      const chunks: Uint8Array[] = [];
      return {
        append: (chunk) =>
          chunks.push(Uint8Array.from(atob(chunk), (c) => c.charCodeAt(0))),
        finish() {
          const bytes = new Uint8Array(
            chunks.reduce((n, c) => n + c.length, 0),
          );
          let at = 0;
          for (const chunk of chunks) {
            bytes.set(chunk, at);
            at += chunk.length;
          }
          return JSON.parse(new TextDecoder().decode(bytes));
        },
      };
    },
  };

/** Aggregate FIFO, charged for the complete retained key and encoded value. */
export class MessagePrefetchCache {
  #entries = new Map<
    string,
    { session: string; at: number; bytes: Uint8Array; size: number }
  >();
  #bytes = 0;
  constructor(
    readonly policy: { prefetchms: number; prefetchbytes: number },
    readonly now = () => performance.now(),
  ) {}
  #remove(key: string): void {
    const entry = this.#entries.get(key);
    if (!entry) return;
    this.#bytes -= entry.size;
    this.#entries.delete(key);
  }
  #expire(): void {
    for (const [key, entry] of this.#entries) {
      if (this.now() - entry.at >= this.policy.prefetchms) this.#remove(key);
    }
  }
  get bytes(): number {
    this.#expire();
    return this.#bytes;
  }
  get(key: string): PrefetchPage | undefined {
    this.#expire();
    const entry = this.#entries.get(key);
    return entry && JSON.parse(new TextDecoder().decode(entry.bytes));
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
    for (const [key, entry] of this.#entries) {
      if (session === undefined || entry.session === session) this.#remove(key);
    }
  }
}
