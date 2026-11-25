// SPDX-License-Identifier: LGPL-3.0-only
import type { OpenCodeClient, V2Client } from "./client.ts";
import { HarnessError } from "@otk/harness";
import { OperationFailure } from "@otk/protocol";
import { opencodeV2SessionID as ids } from "./ids.ts";
import type { V2Event } from "./stream.ts";
export type NativeMessage = Awaited<
  ReturnType<OpenCodeClient["message"]["list"]>
>["data"][number];
import type { NativeSession } from "./metadata.ts";
export type { NativeSession } from "./metadata.ts";
/** Exact stock inventory, not prefix suppression: future subtypes stay records. */
const nativeSessionEvents = new Set([
  "created",
  "forked",
  "renamed",
  "moved",
  "metadata.updated",
  "archived",
  "unarchived",
  "deleted",
  "viewed",
  "permissions",
  "usage.recorded",
  "usage.updated",
  "agent.selected",
  "model.selected",
  "message.content.updated",
  "execution.started",
  "execution.succeeded",
  "execution.failed",
  "execution.interrupted",
  "retry.scheduled",
  "inbox.enqueued",
  "inbox.delivered",
  "inbox.cancelled",
  "inbox.delivery.changed",
  "step.started",
  "step.streamed",
  "step.ended",
  "step.failed",
  "text.started",
  "text.delta",
  "text.ended",
  "reasoning.started",
  "reasoning.delta",
  "reasoning.ended",
  "tool.input.started",
  "tool.input.delta",
  "tool.input.ended",
  "tool.called",
  "tool.progress",
  "tool.success",
  "tool.failed",
  "compaction.started",
  "compaction.delta",
  "compaction.ended",
  "compaction.failed",
  "synthetic",
  "instructions.updated",
  "skill.activated",
  "shell.started",
  "shell.ended",
  "revert.staged",
  "revert.cleared",
  "revert.committed",
].map((name) => `session.${name}`));
export const knownSessionEvent = (type: string): boolean =>
  nativeSessionEvents.has(type);
/** Mirror stock message-updater, before the shared record classifier. A textless
 * instruction observation has no chronological native message to project. */
export function eventMessage(
  event: V2Event,
  previous?: NativeSession,
): NativeMessage | undefined {
  const d = event.data, id = event.id?.replace(/^evt_/, "msg_");
  if (!id) return;
  const boundary = {
    id,
    metadata: event.metadata,
    time: { created: event.created ?? Date.now() },
  };
  if (event.type === "session.agent.selected") {
    return {
      ...boundary,
      type: "agent-switched",
      agent: d.agent,
      previous: d.previous ?? previous?.agent ?? undefined,
    } as NativeMessage;
  }
  if (event.type === "session.model.selected") {
    return {
      ...boundary,
      type: "model-switched",
      model: d.model,
      previous: d.previous ?? previous?.model ?? undefined,
    } as NativeMessage;
  }
  if (event.type === "session.moved") {
    return {
      ...boundary,
      type: "location-switched",
      location: d.location,
      projectID: d.projectID,
      subpath: d.subpath,
      previous: previous
        ? {
          location: previous.location,
          projectID: previous.projectID,
          subpath: previous.subpath,
        }
        : undefined,
    } as NativeMessage;
  }
  if (/^session\.execution\.(succeeded|failed|interrupted)$/.test(event.type)) {
    if (event.type.endsWith("interrupted") && d.reason === "shutdown") return;
    return {
      ...boundary,
      type: "idle",
      outcome: event.type.split(".").at(-1),
      ...(d.error ? { error: d.error } : {}),
    } as NativeMessage;
  }
  if (typeof d.text !== "string") return;
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
type InboxRead =
  | {
    state: "available";
    items: Awaited<ReturnType<OpenCodeClient["session"]["inbox"]["list"]>>;
  }
  | { state: "unsupported"; diagnosticID: string };
/** One bounded native collection reader. Cursor requests NEVER include order. */
export class Messages {
  /** Capability absence belongs to one endpoint generation, not one page. */
  #unsupportedInbox = new WeakMap<V2Client, OperationFailure>();
  #inboxProbe = new WeakMap<V2Client, Promise<void>>();
  constructor(readonly client: () => V2Client) {}
  async inbox(
    id: string,
    signal: AbortSignal,
  ): Promise<InboxRead> {
    ids.decode(id);
    signal.throwIfAborted();
    const client = this.client();
    // Concurrent session acquisitions share capability discovery, never bodies.
    const pending = this.#inboxProbe.get(client);
    if (pending) {
      let abort!: () => void;
      const waiting = new Promise<void>((resolve, reject) => {
        abort = () => reject(signal.reason);
        signal.addEventListener("abort", abort, { once: true });
        if (signal.aborted) abort();
        pending.then(resolve, reject);
      });
      try {
        await client.wait(waiting);
      } finally {
        signal.removeEventListener("abort", abort);
      }
    }
    signal.throwIfAborted();
    const unsupported = this.#unsupportedInbox.get(client);
    if (unsupported) {
      client.signal.throwIfAborted();
      return { state: "unsupported", diagnosticID: unsupported.diagnosticID };
    }
    const reading = this.#inbox(id, signal, client);
    const probe = reading.then(() => {}, () => {});
    this.#inboxProbe.set(client, probe);
    try {
      return await reading;
    } finally {
      if (this.#inboxProbe.get(client) === probe) {
        this.#inboxProbe.delete(client);
      }
    }
  }
  async #inbox(
    id: string,
    signal: AbortSignal,
    client: V2Client,
  ): Promise<InboxRead> {
    try {
      const items = await client.read(
        (api) =>
          api.session.inbox.list({ sessionID: ids.decode(id) }, { signal }),
        signal,
      );
      return { state: "available", items };
    } catch (cause) {
      // Native missing-session tags are classified separately by V2Client. Only
      // an absent/unsupported route proves this optional capability unavailable.
      if (
        !(cause instanceof OperationFailure) ||
        ![404, 405, 501].includes(cause.facts?.status ?? 0)
      ) throw cause;
      this.#unsupportedInbox.set(client, cause);
      return { state: "unsupported", diagnosticID: cause.diagnosticID };
    }
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
      "bulk",
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
