// SPDX-License-Identifier: LGPL-3.0-only
import type { PluginStorage } from "@otk/harness";
import type { ContextMessage } from "@otk/protocol";

interface SavedRecord {
  version: 1;
  id: string;
  sessionID: string;
  created: number;
  request?: Record<string, unknown>;
  nativeRequest?: boolean;
  message?: ContextMessage;
}
const reverseID = (id: string): string =>
  id.split("").map((char) =>
    (65535 - char.charCodeAt(0)).toString(16).padStart(4, "0")
  ).join("") + "ffff";
/** V1 owns its schema and migration. Host storage contains only opaque values. */
export class V1RecordRetention {
  #memory = new Map<string, string>();
  #storage?: PluginStorage;
  bind(storage: PluginStorage): void {
    const version = storage.get("records/schema");
    if (version !== undefined && version !== "1") {
      throw new Error("Unsupported V1 retained record schema");
    }
    storage.transaction(() => {
      storage.set("records/schema", "1");
      for (const [key, value] of this.#memory) storage.set(key, value);
    });
    this.#memory.clear();
    this.#storage = storage;
  }
  #prefix(session: string): string {
    return `records/identity/${encodeURIComponent(session)}/`;
  }
  #timeline(session: string): string {
    return `records/timeline/${encodeURIComponent(session)}/`;
  }
  #key(row: SavedRecord): string {
    return this.#prefix(row.sessionID) + encodeURIComponent(row.id);
  }
  #order(row: SavedRecord): string {
    return this.#timeline(row.sessionID) +
      String(Number.MAX_SAFE_INTEGER - row.created).padStart(16, "0") + "/" +
      reverseID(row.id);
  }
  #get(key: string): string | undefined {
    return this.#storage?.get(key) ?? this.#memory.get(key);
  }
  #set(key: string, value: string): void {
    if (this.#storage) this.#storage.set(key, value);
    else this.#memory.set(key, value);
  }
  get(sessionID: string, id: string): SavedRecord | undefined {
    const value = this.#get(this.#prefix(sessionID) + encodeURIComponent(id));
    if (!value) return;
    const row: SavedRecord = JSON.parse(value);
    if (row.version !== 1 || row.sessionID !== sessionID || row.id !== id) {
      throw new Error("Invalid V1 retained record");
    }
    return row;
  }
  /** Every request observation belongs here, regardless of transport. */
  observe(
    sessionID: string,
    id: string,
    request: Record<string, unknown>,
    created: number,
    nativeRequest = false,
  ): void {
    const previous = this.get(sessionID, id);
    // A late inventory/ask cannot overwrite a terminal outcome or downgrade raw
    // native evidence to the normalized inventory representation.
    if (previous?.message || (previous?.nativeRequest && !nativeRequest)) {
      return;
    }
    this.put({
      id,
      sessionID,
      created: previous?.created ?? created,
      request,
      nativeRequest,
    });
  }
  put(row: Omit<SavedRecord, "version">): void {
    const saved: SavedRecord = { ...row, version: 1 };
    const write = () => {
      this.#set(this.#key(saved), JSON.stringify(saved));
      if (saved.message) {
        this.#set(this.#order(saved), JSON.stringify(saved.message));
      }
    };
    if (this.#storage) this.#storage.transaction(write);
    else write();
  }
  page(
    sessionID: string,
    before: { created: number; id: string } | undefined,
    limit: number,
  ): ContextMessage[] {
    const prefix = this.#timeline(sessionID);
    // Chronological key is newest first, independently of provider message IDs.
    const after = before
      ? prefix +
        String(Number.MAX_SAFE_INTEGER - before.created).padStart(16, "0") +
        "/" + reverseID(before.id)
      : undefined;
    const rows = this.#storage
      ? this.#storage.scan({ prefix, after, limit })
      : [...this.#memory].filter(([key]) =>
        key.startsWith(prefix) && (!after || key > after)
      ).sort(([a], [b]) => a.localeCompare(b)).slice(0, limit).map((
        [key, value],
      ) => ({ key, value }));
    return rows.map(({ value }) => JSON.parse(value) as ContextMessage);
  }
  remove(sessionID: string): void {
    for (const prefix of [this.#prefix(sessionID), this.#timeline(sessionID)]) {
      if (!this.#storage) {
        for (const key of this.#memory.keys()) {
          if (key.startsWith(prefix)) this.#memory.delete(key);
        }
        continue;
      }
      for (;;) {
        const rows = this.#storage.scan({ prefix, limit: 100 });
        if (!rows.length) break;
        this.#storage.transaction(() => {
          for (const row of rows) this.#storage!.delete(row.key);
        });
      }
    }
  }
}
