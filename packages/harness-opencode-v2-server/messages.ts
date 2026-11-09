// SPDX-License-Identifier: LGPL-3.0-only
import type { OpenCodeClient, V2Client } from "./client.ts";
import { HarnessError } from "@otk/harness";
import { opencodeV2SessionID as ids } from "./ids.ts";
export type NativeMessage = Awaited<
  ReturnType<OpenCodeClient["message"]["list"]>
>["data"][number];
export type NativeSession = Awaited<
  ReturnType<OpenCodeClient["session"]["get"]>
>;
export interface NativePage {
  items: NativeMessage[];
  next?: string;
}
export const SCAN_ROWS = 200;
export function nativeCursor(id: string): string {
  return btoa(JSON.stringify({ id, order: "desc", direction: "next" }))
    .replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}
export function nativeForwardCursor(id: string): string {
  return btoa(JSON.stringify({ id, order: "asc", direction: "next" }))
    .replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}
/** One bounded native collection reader. Cursor requests NEVER include order. */
export class Messages {
  constructor(readonly client: () => V2Client) {}
  async forward(
    id: string,
    cursor: string,
    signal: AbortSignal,
  ): Promise<NativePage> {
    const result = await this.client().read(
      (api) =>
        api.message.list({
          sessionID: ids.decode(id),
          cursor,
          limit: SCAN_ROWS,
        }, { signal }),
      signal,
    );
    return {
      items: [...result.data],
      next: result.data.length === SCAN_ROWS
        ? result.cursor.next ?? undefined
        : undefined,
    };
  }
  async page(
    id: string,
    limit: number,
    cursor?: string,
    signal?: AbortSignal,
    type?: NativeMessage["type"],
  ): Promise<NativePage> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > SCAN_ROWS) {
      throw new RangeError("Invalid message page size");
    }
    const result = await this.client().read(
      (api) =>
        api.message.list({
          sessionID: ids.decode(id),
          limit,
          ...(cursor ? { cursor } : { order: "desc" as const }),
          ...(type ? { type } : {}),
        }, { signal }),
      signal,
    );
    return {
      items: [...result.data].reverse(),
      next: result.data.length === limit
        ? result.cursor.next ?? undefined
        : undefined,
    };
  }
  async get(
    id: string,
    messageID: string,
    signal?: AbortSignal,
  ): Promise<NativeMessage> {
    let cursor: string | undefined;
    do {
      const page = await this.page(id, SCAN_ROWS, cursor, signal);
      const found = page.items.find((m) => m.id === messageID);
      if (found) return found;
      cursor = page.next;
    } while (cursor);
    throw new HarnessError("message", "That message is no longer available.");
  }
  /** Untested servers keep ownership of their opaque continuation format. */
  async before(
    id: string,
    cutoff: string,
    signal: AbortSignal,
  ): Promise<NativePage> {
    let cursor: string | undefined;
    do {
      signal.throwIfAborted();
      const page = await this.page(id, 10, cursor, signal);
      const boundary = page.items.findIndex((message) => message.id === cutoff);
      if (boundary !== -1) {
        return { items: page.items.slice(0, boundary), next: page.next };
      }
      cursor = page.next;
    } while (cursor);
    throw new HarnessError(
      "cursor-stale",
      "Revert boundary changed. Refresh messages.",
    );
  }
}
