// SPDX-License-Identifier: LGPL-3.0-only
import {
  MAX_SESSION_LIST_SIZE,
  SESSION_LIST_SIZE,
  type SessionListInput,
  sessionListKey,
} from "@otk/protocol";
import type { SessionListResult } from "@otk/harness";
import { HarnessError } from "@otk/harness";
import type { Client } from "./client.ts";
import type { DigestNativeDb } from "./digest-db.ts";
import { opencodeV1SessionID as ids } from "./ids.ts";
import { mapIndex } from "./map.ts";
import type { Session } from "./types.ts";

/** Coverage belongs to source pages, never to hydrated index membership. */
export class SessionLists {
  #pages = new Map<string, SessionListResult>();
  #generation = crypto.randomUUID();
  constructor(
    readonly client: Client,
    readonly native: (
      signal: AbortSignal,
    ) => Promise<DigestNativeDb | undefined>,
    readonly wait: <T>(value: Promise<T>) => Promise<T> = (value) => value,
  ) {}
  reset(): void {
    this.#generation = crypto.randomUUID();
    this.#pages.clear();
  }
  invalidate(): void {
    this.#pages.clear();
  }
  async read(
    input: SessionListInput,
    signal: AbortSignal,
    client = this.client,
    wait: <T>(value: Promise<T>) => Promise<T> = this.wait,
  ): Promise<SessionListResult> {
    signal.throwIfAborted();
    const generation = this.#generation,
      limit = input.limit ?? SESSION_LIST_SIZE;
    if (
      !Number.isSafeInteger(limit) || limit < 1 || limit > MAX_SESSION_LIST_SIZE
    ) {
      throw new HarnessError("params", "Invalid session list size");
    }
    const scope = sessionListKey({ ...input, before: undefined });
    let cursor: {
      scope: string;
      generation: string;
      updated: number;
      id: string;
      mode: "sql" | "api";
      native?: string;
    } | undefined;
    if (input.before) {
      try {
        cursor = JSON.parse(
          new TextDecoder().decode(
            Uint8Array.from(atob(input.before), (value) => value.charCodeAt(0)),
          ),
        );
        if (
          !cursor || cursor.scope !== scope ||
          cursor.generation !== generation ||
          !Number.isFinite(cursor.updated) || typeof cursor.id !== "string" ||
          (cursor.mode !== "sql" && cursor.mode !== "api") ||
          cursor.mode === "api" && typeof cursor.native !== "string"
        ) throw new Error();
      } catch {
        throw new HarnessError(
          "params",
          "Session list cursor no longer matches this request",
        );
      }
    }
    const key = sessionListKey(input);
    const cached = this.#pages.get(key);
    if (cached) return cached;
    const native = await this.native(signal);
    signal.throwIfAborted();
    let items: SessionListResult["items"], older: string | null;
    const encode = (
      last: SessionListResult["items"][number],
      continuation?: string,
    ) =>
      btoa(
        Array.from(
          new TextEncoder().encode(JSON.stringify({
            scope,
            generation,
            updated: last.timeUpdated,
            id: ids.decode(last.id),
            mode: continuation === undefined ? "sql" : "api",
            ...(continuation === undefined ? {} : { native: continuation }),
          })),
          (value) => String.fromCharCode(value),
        ).join(""),
      );
    const sql = native && native.fileIdentity() === native.identity;
    if (cursor?.mode === "sql" && !sql) {
      throw new Error("Session list SQL authority is unavailable");
    }
    if (sql && cursor?.mode !== "api") {
      items = native.listSessions(input, cursor, limit);
      older = items.length === limit ? encode(items.at(-1)!) : null;
    } else if (typeof input.parentID === "string") {
      // The native family endpoint, unlike a directory listing, keeps moved
      // children. Its response is scoped to this parent, never all sessions.
      const response = await client.request(
        `/session/${ids.decode(input.parentID)}/children`,
        { signal },
      );
      const rows: Session[] = await wait(response.json());
      const candidates = rows.map(mapIndex).filter((row) =>
        row.parentID === input.parentID &&
        (!input.query ||
          row.title.toLowerCase().includes(input.query.toLowerCase())) &&
        (!cursor || row.timeUpdated < cursor.updated ||
          row.timeUpdated === cursor.updated && ids.decode(row.id) < cursor.id)
      )
        .sort((a, b) =>
          b.timeUpdated - a.timeUpdated || b.id.localeCompare(a.id)
        );
      items = candidates.slice(0, limit);
      older = candidates.length > limit
        ? encode(items.at(-1)!, "family")
        : null;
    } else {
      items = [];
      older = null;
      let continuation = cursor?.native;
      const visited = new Set<string>();
      do {
        const response = await client.request("/experimental/session", {
          query: {
            directory: input.directory,
            search: input.query,
            roots: input.parentID === null ? "true" : undefined,
            cursor: continuation,
            limit: limit - items.length,
          },
          signal,
        });
        const rows: Session[] = await wait(response.json());
        items.push(
          ...rows.filter((row) =>
            row.directory === input.directory &&
            (input.parentID === undefined || (input.parentID === null
              ? !row.parentID
              : row.parentID === ids.decode(input.parentID)))
          )
            .map(mapIndex).slice(0, limit - items.length),
        );
        const next = response.headers.get("x-next-cursor");
        const last = rows.at(-1);
        if (next && (!last || visited.has(next) || next === continuation)) {
          throw new Error("Native session list cursor did not advance");
        }
        continuation = next ?? undefined;
        if (next) visited.add(next);
        older = next && last ? encode(mapIndex(last), next) : null;
      } while (continuation && items.length < limit);
    }
    signal.throwIfAborted();
    if (generation !== this.#generation) {
      throw new Error("Session list generation changed");
    }
    const value = { items, older, generation };
    this.#pages.set(key, value);
    return value;
  }
}
