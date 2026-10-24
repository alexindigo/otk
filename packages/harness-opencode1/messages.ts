// SPDX-License-Identifier: LGPL-3.0-only
import { HarnessError } from "@otk/harness";
import type { Client } from "./client.ts";
import type { Info, RawPart } from "./types.ts";

export interface NativeMessage {
  info: Info;
  parts: RawPart[];
}

/** The only collection endpoint owner. Even metadata scans release each page. */
export class Messages {
  constructor(
    readonly client: Client,
    readonly directory: (id: string) => string | undefined,
  ) {}
  async page(
    id: string,
    limit: number,
    before?: string,
    directory = this.directory(id),
    signal?: AbortSignal,
  ): Promise<{
    items: NativeMessage[];
    next?: string;
  }> {
    // Stock treats both an absent limit and zero as "all messages".
    if (!Number.isInteger(limit) || limit < 1 || limit > 200) {
      throw new HarnessError("params", "limit must be 1..200");
    }
    const response = await this.client.request(
      `/session/${encodeURIComponent(id)}/message`,
      { query: { directory, limit, before }, signal },
    );
    const items: NativeMessage[] = await response.json();
    const next = response.headers.get("x-next-cursor") ?? undefined;
    if (next && (next === before || !items.length)) {
      throw new Error("Harness message pagination did not advance");
    }
    return { items, next };
  }
  async *scan(
    id: string,
    directory = this.directory(id),
    signal?: AbortSignal,
  ): AsyncIterable<NativeMessage> {
    let before: string | undefined;
    do {
      signal?.throwIfAborted();
      const page = await this.page(id, 100, before, directory, signal);
      signal?.throwIfAborted();
      yield* page.items;
      before = page.next;
    } while (before);
  }
  async get(
    id: string,
    message: string,
    signal?: AbortSignal,
  ): Promise<NativeMessage> {
    return await this.client.json<NativeMessage>(
      `/session/${encodeURIComponent(id)}/message/${
        encodeURIComponent(message)
      }`,
      { query: { directory: this.directory(id) }, signal },
    );
  }
}
