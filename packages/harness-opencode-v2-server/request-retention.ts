// SPDX-License-Identifier: LGPL-3.0-only
import type { PluginStorage } from "@otk/harness";
import type { Message } from "@otk/protocol";

/**
 * Plugin position of an ephemeral native observation (form/permission
 * settlement). Native durable messages are ordered by their session
 * aggregate's `seq`; ephemeral events have none. `after` is the last durable
 * sequence of the session aggregate delivered before the observation, so the
 * observation sits strictly between native `after` and `after + 1`, ordered by
 * `rank` among observations that share `after`.
 *
 * - `stream`: proven by delivery order (watermark, or the first durable event
 *   of the aggregate after the observation, which has `after + 1`).
 * - `lookup`: no durable event followed before disconnect; `after` is the
 *   native latest message sequence read after the observation (upper bound).
 * - `clock`: no sequence evidence; placed only by its native creation clock.
 * - `pending`: awaiting evidence; placed by clock until resolved.
 */
export interface RequestPosition {
  after: number | null;
  rank: number;
  basis: "stream" | "lookup" | "clock" | "pending";
}
export interface RetainedRequest {
  id: string;
  sessionID: string;
  request?: Record<string, unknown>;
  /** Stored without `sourceOrder`; the position projects it. */
  outcome?: Message;
  position?: RequestPosition;
}
export interface RequestEdge {
  created: number;
  id: string;
  order?: number;
}
export type RequestIndex = "timeline" | "sequence" | "unanchored";
/** V2 owns the record schema, migrations and position indexes. */
export interface RequestRetention {
  bind(storage: PluginStorage): void;
  get(sessionID: string, id: string): Promise<RetainedRequest | undefined>;
  put(value: RetainedRequest): Promise<void>;
  /** Next rank after the observations already placed at `after`. */
  rank(sessionID: string, after: number): number;
  page(
    sessionID: string,
    before: RequestEdge | undefined,
    limit: number,
    index?: RequestIndex,
  ): Promise<readonly Message[]>;
  /** Native revert boundary sequence staged for a session, if known. */
  cutoff(sessionID: string, seq?: number | null): number | undefined;
  /** Retires sequence-anchored observations at or after a committed boundary. */
  retire(sessionID: string, from: number): Promise<number>;
  remove(sessionID: string): Promise<void>;
  close(): Promise<void>;
}
/** Projects a position into the protocol's numeric order. Never an integer. */
export function positionOrder(position: RequestPosition): number | undefined {
  return position.after === null || position.basis === "pending"
    ? undefined
    : position.after + position.rank / (position.rank + 1);
}
const prefix = (sessionID: string, kind: string) =>
  `requests/${kind}/${encodeURIComponent(sessionID)}/`;
const reverseID = (id: string) =>
  Array.from(
    id.split(""),
    (char) => (65535 - char.charCodeAt(0)).toString(16).padStart(4, "0"),
  ).join("") + "ffff";
const descending = (value: number) =>
  String(Number.MAX_SAFE_INTEGER - value).padStart(16, "0");
const clockKey = (edge: { created: number; id: string }) =>
  descending(edge.created) + "/" + reverseID(edge.id);
const sequenceKey = (after: number, rank: number) =>
  descending(after) + "/" + descending(rank);
/** Exclusive scan start for `sourceOrder < order` in the sequence index. */
function sequenceAfter(order: number): string | null | undefined {
  const after = Math.floor(order), fraction = order - after;
  if (!fraction) return after < 1 ? null : descending(after - 1) + "/";
  return sequenceKey(after, Math.round(fraction / (1 - fraction)));
}
export class V2RequestRetention implements RequestRetention {
  // Pre-composition staging and standalone adapter tests; production binds before start.
  #pending = new Map<string, string>();
  #storage?: PluginStorage;
  bind(storage: PluginStorage): void {
    const version = storage.get("requests/schema");
    if (version !== undefined && version !== "1") {
      throw new Error("Unsupported V2 request schema");
    }
    storage.transaction(() => {
      storage.set("requests/schema", "1");
      for (const [key, value] of this.#pending) storage.set(key, value);
    });
    this.#pending.clear();
    this.#storage = storage;
  }
  #get(key: string) {
    return this.#storage ? this.#storage.get(key) : this.#pending.get(key);
  }
  #set(key: string, value: string) {
    if (this.#storage) this.#storage.set(key, value);
    else this.#pending.set(key, value);
  }
  #delete(key: string) {
    if (this.#storage) this.#storage.delete(key);
    else this.#pending.delete(key);
  }
  #write<T>(run: () => T): T {
    return this.#storage ? this.#storage.transaction(run) : run();
  }
  #scan(input: { prefix: string; after?: string; limit: number }) {
    if (!Number.isSafeInteger(input.limit) || input.limit < 1) {
      throw new TypeError("Expected positive request page size");
    }
    return this.#storage
      ? this.#storage.scan(input)
      : [...this.#pending].filter(([key]) =>
        key.startsWith(input.prefix) && (!input.after || key > input.after)
      ).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).slice(0, input.limit)
        .map(([key, value]) => ({ key, value }));
  }
  #read(sessionID: string, id: string): RetainedRequest | undefined {
    const value = this.#get(
      prefix(sessionID, "identity") + encodeURIComponent(id),
    );
    if (!value) return;
    const row = JSON.parse(value);
    if (row.version !== 1 || row.sessionID !== sessionID || row.id !== id) {
      throw new Error("Invalid V2 retained request");
    }
    return row;
  }
  get(sessionID: string, id: string): Promise<RetainedRequest | undefined> {
    return Promise.resolve(this.#read(sessionID, id));
  }
  #keys(value: RetainedRequest): [string, string][] {
    const { outcome, position } = value;
    if (!outcome) return [];
    const { sourceOrder: _, ...stored } = outcome;
    const edge = { created: outcome.time.created, id: outcome.id };
    const keys: [string, string][] = [[
      prefix(value.sessionID, "timeline") + clockKey(edge),
      JSON.stringify(stored),
    ]];
    const order = position && positionOrder(position);
    if (order !== undefined) {
      keys.push([
        prefix(value.sessionID, "sequence") +
        sequenceKey(position!.after!, position!.rank),
        JSON.stringify({ ...stored, sourceOrder: order }),
      ]);
    } else if (position) {
      // Pending and clock positions keep a clock placement, so an
      // interrupted resolution never leaves the record without a page index.
      keys.push([
        prefix(value.sessionID, "unanchored") + clockKey(edge),
        JSON.stringify(stored),
      ]);
    }
    return keys;
  }
  #replace(previous: RetainedRequest | undefined, value?: RetainedRequest) {
    if (previous) {
      for (const [key] of this.#keys(previous)) {
        this.#delete(key);
      }
    }
    if (value) {
      for (const [key, row] of this.#keys(value)) this.#set(key, row);
      const { outcome, ...rest } = value;
      if (outcome) {
        const { sourceOrder: _, ...stored } = outcome;
        this.#set(
          prefix(value.sessionID, "identity") + encodeURIComponent(value.id),
          JSON.stringify({ ...rest, outcome: stored, version: 1 }),
        );
      } else {
        this.#set(
          prefix(value.sessionID, "identity") + encodeURIComponent(value.id),
          JSON.stringify({ ...rest, version: 1 }),
        );
      }
    } else if (previous) {
      this.#delete(
        prefix(previous.sessionID, "identity") +
          encodeURIComponent(previous.id),
      );
    }
  }
  put(value: RetainedRequest): Promise<void> {
    this.#write(() =>
      this.#replace(this.#read(value.sessionID, value.id), value)
    );
    return Promise.resolve();
  }
  rank(sessionID: string, after: number): number {
    const key = prefix(sessionID, "sequence") + descending(after) + "/",
      [top] = this.#scan({ prefix: key, limit: 1 });
    return top
      ? Number.MAX_SAFE_INTEGER - Number(top.key.slice(key.length)) + 1
      : 1;
  }
  page(
    sessionID: string,
    before: RequestEdge | undefined,
    limit: number,
    index: RequestIndex = "timeline",
  ): Promise<readonly Message[]> {
    const key = prefix(sessionID, index);
    let after: string | undefined;
    if (index === "sequence") {
      const start = before?.order === undefined
        ? undefined
        : sequenceAfter(before.order);
      if (start === null) return Promise.resolve([]);
      after = start === undefined ? undefined : key + start;
    } else if (before) after = key + clockKey(before);
    return Promise.resolve(
      this.#scan({ prefix: key, after, limit }).map(({ value }) =>
        JSON.parse(value) as Message
      ),
    );
  }
  cutoff(sessionID: string, seq?: number | null): number | undefined {
    const key = prefix(sessionID, "cutoff").slice(0, -1);
    if (seq === null) this.#delete(key);
    else if (seq !== undefined) this.#set(key, String(seq));
    const value = this.#get(key);
    return value === undefined ? undefined : Number(value);
  }
  retire(sessionID: string, from: number): Promise<number> {
    const key = prefix(sessionID, "sequence");
    let retired = 0;
    for (;;) {
      // Newest positions sort first; stop at the first one before the boundary.
      const rows = this.#scan({ prefix: key, limit: 100 }).filter((row) =>
        Number.MAX_SAFE_INTEGER -
            Number(row.key.slice(key.length, key.length + 16)) >= from
      );
      if (!rows.length) break;
      this.#write(() => {
        for (const row of rows) {
          const id = String(JSON.parse(row.value).id).replace(/^request:/, "");
          const previous = this.#read(sessionID, id);
          if (previous) this.#replace(previous);
          else this.#delete(row.key);
          retired++;
        }
      });
    }
    return Promise.resolve(retired);
  }
  remove(sessionID: string): Promise<void> {
    for (
      const kind of ["identity", "timeline", "sequence", "unanchored", "cutoff"]
    ) {
      for (;;) {
        const rows = kind === "cutoff"
          ? [prefix(sessionID, kind).slice(0, -1)].filter((k) =>
            this.#get(k) !== undefined
          ).map((key) => ({ key }))
          : this.#scan({ prefix: prefix(sessionID, kind), limit: 100 });
        if (!rows.length) break;
        this.#write(() => {
          for (const row of rows) this.#delete(row.key);
        });
      }
    }
    return Promise.resolve();
  }
  close(): Promise<void> {
    this.#pending.clear();
    this.#storage = undefined;
    return Promise.resolve();
  }
}
