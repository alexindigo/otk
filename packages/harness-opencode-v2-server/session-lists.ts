// SPDX-License-Identifier: LGPL-3.0-only
import { HarnessError, type SessionListResult } from "@otk/harness";
import {
  MAX_SESSION_LIST_SIZE,
  OperationFailure,
  SESSION_LIST_SIZE,
  type SessionListInput,
  sessionListKey,
} from "@otk/protocol";
import { opencodeV2SessionID as ids } from "./ids.ts";
import { metadata } from "./metadata.ts";
import type { V2Client } from "./client.ts";
import type { V2NativeDb } from "./native-db.ts";
type Cursor = {
  scope: string;
  generation: string;
  mode: string;
  updated: number;
  id: string;
  native?: string;
};
export class V2SessionLists {
  #generation = crypto.randomUUID();
  #pages = new Map<string, SessionListResult>();
  #dataVersion?: number;
  reset(): void {
    this.#generation = crypto.randomUUID();
    this.#pages.clear();
    this.#dataVersion = undefined;
  }
  invalidate(): void {
    this.#pages.clear();
  }
  async read(
    input: SessionListInput,
    client: V2Client,
    db: V2NativeDb | undefined,
    signal: AbortSignal,
  ): Promise<SessionListResult> {
    signal.throwIfAborted();
    if (db) {
      const version = db.dataVersion();
      if (version !== this.#dataVersion) this.invalidate();
      this.#dataVersion = version;
    }
    const limit = input.limit ?? SESSION_LIST_SIZE,
      generation = this.#generation;
    if (
      !Number.isSafeInteger(limit) || limit < 1 || limit > MAX_SESSION_LIST_SIZE
    ) {
      throw new OperationFailure(
        "rejected",
        "native.rejected",
        new HarnessError("params", "Invalid session list size"),
      );
    }
    const scope = sessionListKey({ ...input, before: undefined }),
      mode = db ? `sql:${db.identity}` : "api";
    let cursor: Cursor | undefined;
    if (input.before) {
      try {
        cursor = JSON.parse(
          new TextDecoder().decode(
            Uint8Array.from(atob(input.before), (c) => c.charCodeAt(0)),
          ),
        );
        if (
          !cursor || cursor.scope !== scope ||
          cursor.generation !== generation || cursor.mode !== mode ||
          !Number.isFinite(cursor.updated) || typeof cursor.id !== "string" ||
          mode === "api" && typeof cursor.native !== "string"
        ) throw new Error();
      } catch {
        throw new OperationFailure(
          "rejected",
          "native.rejected",
          new HarnessError(
            "params",
            "Session list cursor no longer matches this source generation",
          ),
        );
      }
    }
    const key = sessionListKey(input), cached = this.#pages.get(key);
    if (cached) return cached;
    let items: SessionListResult["items"], next: string | undefined;
    if (db) {
      // One lookahead disambiguates a full terminal page; never enumerates successors.
      const rows = db.list(
        input,
        cursor,
        Math.min(limit + 1, MAX_SESSION_LIST_SIZE),
      );
      items = rows.slice(0, limit);
      if (
        rows.length > limit ||
        limit === MAX_SESSION_LIST_SIZE && rows.length === limit
      ) next = "sql";
    } else {
      const response = await client.read(
        (api) =>
          api.session.list(
            cursor ? { cursor: cursor.native!, limit } : {
              directory: input.directory,
              search: input.query,
              parentID: input.parentID === null
                ? "null"
                : input.parentID
                ? ids.decode(input.parentID)
                : undefined,
              limit,
              order: "desc",
            },
            { signal },
          ),
        signal,
      );
      items = response.data.map(metadata);
      next = response.cursor.next ?? undefined;
      if (next && (next === cursor?.native || !items.length)) {
        throw new Error("Native session list cursor did not advance");
      }
    }
    signal.throwIfAborted();
    if (
      generation !== this.#generation || db && db.fileIdentity() !== db.identity
    ) throw new Error("Session list authority changed");
    const last = items.at(-1);
    const older = next && last
      ? btoa(
        Array.from(
          new TextEncoder().encode(
            JSON.stringify({
              scope,
              generation,
              mode,
              updated: last.timeUpdated,
              id: ids.decode(last.id),
              ...(db ? {} : { native: next }),
            }),
          ),
          (n) => String.fromCharCode(n),
        ).join(""),
      )
      : null;
    const result = { items, older, generation };
    // A bounded speculative cache is not a population catalog.
    if (this.#pages.size >= 32) {
      this.#pages.delete(this.#pages.keys().next().value!);
    }
    this.#pages.set(key, result);
    return result;
  }
}
