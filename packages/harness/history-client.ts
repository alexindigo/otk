// SPDX-License-Identifier: LGPL-3.0-only
import type { HistoryAttachment, HistoryCapability } from "@otk/protocol";
import type { HistoryAttachmentRef, HistoryEntry } from "@otk/protocol";
import type {
  ProviderReadKinds,
  ProviderReadOptions,
  ProviderReadPort,
} from "./provider-reads.ts";
/** Volatile history facade. Native SQL and byte admission remain in the selected worker. */
export class ProviderHistory implements HistoryCapability {
  #owners = new Map<string, AbortController>();
  constructor(readonly source: ProviderReadPort) {}
  async #read<
    K extends "history.list" | "history.entries" | "history.attachments",
  >(
    kind: K,
    input: ProviderReadKinds[K]["input"],
    signal?: AbortSignal,
    priority: ProviderReadOptions["priority"] = "user",
  ): Promise<ProviderReadKinds[K]["result"]> {
    signal?.throwIfAborted();
    const owner = JSON.stringify(["history", crypto.randomUUID()]),
      controller = new AbortController();
    this.#owners.set(owner, controller);
    try {
      return await this.source.read(kind, input, {
        owner,
        priority,
        signal: signal
          ? AbortSignal.any([signal, controller.signal])
          : controller.signal,
      });
    } finally {
      this.#owners.delete(owner);
      this.source.release(owner);
    }
  }
  listHistory(
    signal?: AbortSignal,
    directory?: string,
  ): Promise<HistoryEntry[]> {
    return this.#read("history.list", { directory }, signal);
  }
  entries(
    keys: { sessionID: string; messageID: string }[],
    signal?: AbortSignal,
  ): Promise<HistoryEntry[]> {
    return this.#read("history.entries", { keys }, signal);
  }
  async entry(
    sessionID: string,
    messageID: string,
    signal?: AbortSignal,
    priority: ProviderReadOptions["priority"] = "user",
  ): Promise<HistoryEntry | undefined> {
    return (await this.#read(
      "history.entries",
      { keys: [{ sessionID, messageID }] },
      signal,
      priority,
    ))[0];
  }
  async attachments(
    refs: HistoryAttachmentRef[],
    signal?: AbortSignal,
  ): Promise<HistoryAttachment[]> {
    signal?.throwIfAborted();
    const items = refs.length
      ? await this.#read("history.attachments", { refs }, signal)
      : [];
    if (
      items.length !== refs.length ||
      items.some((item, i) =>
        item.ref.messageID !== refs[i].messageID ||
        item.ref.partID !== refs[i].partID
      )
    ) throw new Error("Recalled attachment identities changed");
    return items;
  }
  async attachment(
    ref: HistoryAttachmentRef,
    signal?: AbortSignal,
  ): Promise<HistoryAttachment["part"]> {
    return (await this.attachments([ref], signal))[0].part;
  }
  close(): void {
    for (const [owner, controller] of this.#owners) {
      controller.abort();
      this.source.release(owner);
    }
    this.#owners.clear();
  }
}
