// SPDX-License-Identifier: LGPL-3.0-only
import type { OpenCodeClient, V2Client } from "./client.ts";
import { HarnessError } from "@otk/harness";
import { opencodeV2SessionID as ids } from "./ids.ts";
import type { V2Event } from "./stream.ts";
export type NativeMessage = Awaited<
  ReturnType<OpenCodeClient["message"]["list"]>
>["data"][number];
export type { NativeSession } from "./metadata.ts";
/** Mirror stock message-updater, before the shared record classifier. A textless
 * instruction observation has no chronological native message to project. */
export function eventMessage(event: V2Event): NativeMessage | undefined {
  const d = event.data, id = event.id?.replace(/^evt_/, "msg_");
  if (!id || typeof d.text !== "string") return;
  const common = {
    id,
    text: d.text,
    time: { created: event.created ?? Date.now() },
  };
  if (event.type === "session.synthetic") {
    return {
      ...common,
      type: "synthetic",
      description: d.description,
      metadata: d.metadata,
    } as NativeMessage;
  }
  if (event.type === "session.instructions.updated") {
    const sources = Object.keys(
      d.delta && typeof d.delta === "object" ? d.delta : {},
    );
    return {
      ...common,
      type: "system",
      description: `Instructions updated: ${sources.join(", ")}`,
      metadata: {
        ...event.metadata,
        notice: "instructions",
        instructionSources: sources,
      },
    };
  }
  if (event.type === "session.skill.activated") {
    return {
      ...common,
      type: "skill",
      skill: d.id,
      name: d.name,
      metadata: event.metadata,
    } as NativeMessage;
  }
}
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
  inbox(
    id: string,
    signal: AbortSignal,
  ): ReturnType<OpenCodeClient["session"]["inbox"]["list"]> {
    return this.client().read(
      (api) =>
        api.session.inbox.list({ sessionID: ids.decode(id) }, { signal }),
      signal,
    );
  }
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
    return await this.client().read(
      (api) =>
        api.session.message.get({ sessionID: ids.decode(id), messageID }, {
          signal,
        }),
      signal,
    );
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
