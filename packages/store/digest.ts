// SPDX-License-Identifier: LGPL-3.0-only
import type { FeatureMigrations } from "./migrations.ts";
import { SqliteDb, type SqliteOptions } from "./sqlite.ts";

/** A derived database; its selected migrations never touch the user-data file. */
export class DigestDb extends SqliteDb {
  constructor(
    path: string,
    migrations: readonly FeatureMigrations[],
    options: SqliteOptions,
  ) {
    super(path, "digest.db", migrations, options);
  }
}
export interface DigestUsageRecord {
  call_count: number | null;
  cost: number | null;
  input: number | null;
  output: number | null;
  reasoning: number | null;
  cache_read: number | null;
  cache_write: number | null;
  time_start: number | null;
  time_end: number | null;
  context_peak: number | null;
  revision: number;
}
export interface DigestSessionRecord extends DigestUsageRecord {
  id: string;
  provider: string;
  parent_id: string | null;
  directory: string;
  project_id: string;
  title: string;
  time_created: number;
  time_updated: number;
  archived: number;
  message_count: number | null;
  last_agent: string | null;
  last_provider: string | null;
  last_model: string | null;
  context_input: number | null;
  context_output: number | null;
  context_reasoning: number | null;
  context_cache_read: number | null;
  context_cache_write: number | null;
  state: "digesting" | "ready" | "unavailable";
  digested_at: number | null;
  native_updated_at: number | null;
  deleted_at: number | null;
  deleted_how: "otk" | "provider" | null;
}
export interface DigestTurnRecord extends DigestUsageRecord {
  session_id: string;
  turn_id: string;
  call_count: number;
}
export interface DigestBookkeepingRecord {
  session_id: string;
  last_message_id: string | null;
  last_message_hash: string | null;
  digested_at: number | null;
  native_updated_at: number | null;
  generation: number;
  dirty: number;
}
export interface DigestCommit {
  helpers?: { upsert: DigestHelperRecord[]; remove: string[] };
  sessions: DigestSessionRecord[];
  turns: {
    upsert: DigestTurnRecord[];
    remove: { session_id: string; turn_id: string }[];
  };
  bookkeeping: DigestBookkeepingRecord[];
}
export interface DigestPersistence {
  helpers(ids: readonly string[]): DigestHelperRecord[];
  catalog(
    provider: string,
    after: string,
    limit: number,
  ): DigestSessionRecord[];
  commit(batch: DigestCommit): void;
  summary(ids: readonly string[]): DigestSessionRecord[];
  turns(
    ids: readonly string[],
    after: string,
    limit: number,
  ): DigestTurnRecord[];
  markDeleted(
    ids: readonly string[],
    at: number,
    how: "otk" | "provider",
  ): void;
  resurrect(ids: readonly string[]): void;
  transaction<T>(run: () => T): T;
}
const sessionColumns = [
  "id",
  "provider",
  "parent_id",
  "directory",
  "project_id",
  "title",
  "time_created",
  "time_updated",
  "archived",
  "message_count",
  "call_count",
  "cost",
  "input",
  "output",
  "reasoning",
  "cache_read",
  "cache_write",
  "time_start",
  "time_end",
  "context_peak",
  "last_agent",
  "last_provider",
  "last_model",
  "context_input",
  "context_output",
  "context_reasoning",
  "context_cache_read",
  "context_cache_write",
  "state",
  "revision",
  "digested_at",
  "native_updated_at",
  "deleted_at",
  "deleted_how",
] as const;
export interface DigestHelperRecord {
  session_id: string;
  state: "digesting" | "ready" | "unavailable";
  revision: number;
  tool_count: number | null;
  current_name: string | null;
  current_title: string | null;
  current_start: number | null;
  time_start: number | null;
  time_end: number | null;
}
const helperColumns = [
  "session_id",
  "state",
  "revision",
  "tool_count",
  "current_name",
  "current_title",
  "current_start",
  "time_start",
  "time_end",
] as const;
const turnColumns = [
  "session_id",
  "turn_id",
  "call_count",
  "cost",
  "input",
  "output",
  "reasoning",
  "cache_read",
  "cache_write",
  "time_start",
  "time_end",
  "context_peak",
  "revision",
] as const;
const bookColumns = [
  "session_id",
  "last_message_id",
  "last_message_hash",
  "digested_at",
  "native_updated_at",
  "generation",
  "dirty",
] as const;
function validate(record: object): void {
  for (const [key, value] of Object.entries(record)) {
    if (typeof value !== "number") continue;
    if (
      !Number.isFinite(value) || value < 0 || value > Number.MAX_SAFE_INTEGER ||
      (key !== "cost" && !Number.isSafeInteger(value))
    ) {
      throw new TypeError(`Invalid digest counter: ${key}`);
    }
  }
}
function limitRows(limit: number): void {
  if (!Number.isSafeInteger(limit) || limit < 1) {
    throw new TypeError("Invalid row limit");
  }
}
/** Exclusive composite cursor; turn identities need not be unique across sessions. */
export function digestTurnCursor(
  row: Pick<DigestTurnRecord, "turn_id" | "session_id">,
): string {
  return JSON.stringify([row.turn_id, row.session_id]);
}
/** Scalar records only; table/column allowlists are owned here, never supplied by a sink. */
export class DigestStore implements DigestPersistence {
  constructor(readonly db: DigestDb) {}
  helpers(ids: readonly string[]): DigestHelperRecord[] {
    return this.db.connection.prepare(
      "SELECT * FROM digest_helpers WHERE session_id IN (SELECT value FROM json_each(?)) ORDER BY session_id",
    ).all(JSON.stringify(ids)) as unknown as DigestHelperRecord[];
  }
  catalog(
    provider: string,
    after: string,
    limit: number,
  ): DigestSessionRecord[] {
    limitRows(limit);
    return this.db.connection.prepare(
      "SELECT * FROM digest_sessions WHERE provider=? AND id>? ORDER BY id LIMIT ?",
    ).all(provider, after, limit) as unknown as DigestSessionRecord[];
  }
  summary(ids: readonly string[]): DigestSessionRecord[] {
    return this.db.connection.prepare(
      "SELECT * FROM digest_sessions WHERE id IN (SELECT value FROM json_each(?)) ORDER BY id",
    ).all(JSON.stringify(ids)) as unknown as DigestSessionRecord[];
  }
  turn(sessionID: string, turnID: string): DigestTurnRecord | undefined {
    return this.db.connection.prepare(
      "SELECT * FROM digest_turns WHERE session_id=? AND turn_id=?",
    ).get(sessionID, turnID) as unknown as DigestTurnRecord | undefined;
  }
  turns(
    ids: readonly string[],
    after: string,
    limit: number,
  ): DigestTurnRecord[] {
    limitRows(limit);
    const cursor: unknown = after === "" ? ["", ""] : JSON.parse(after);
    if (
      !Array.isArray(cursor) || cursor.length !== 2 ||
      !cursor.every((value) => typeof value === "string")
    ) throw new TypeError("Invalid digest turn cursor");
    return this.db.connection.prepare(
      "SELECT * FROM digest_turns WHERE session_id IN (SELECT value FROM json_each(?)) AND (turn_id,session_id)>(?,?) ORDER BY turn_id,session_id LIMIT ?",
    ).all(
      JSON.stringify(ids),
      cursor[0],
      cursor[1],
      limit,
    ) as unknown as DigestTurnRecord[];
  }
  commit(batch: DigestCommit): void {
    const write = () => {
      const upsert = <T extends object>(
        table: string,
        columns: readonly (keyof T & string)[],
        keys: readonly string[],
        rows: T[],
      ) => {
        const query = this.db.connection.prepare(
          `INSERT INTO ${table}(${columns.join(",")}) VALUES(${
            columns.map(() => "?").join(",")
          }) ON CONFLICT(${keys.join(",")}) DO UPDATE SET ${
            columns.filter((c) => !keys.includes(c)).map((c) =>
              `${c}=excluded.${c}`
            ).join(",")
          }`,
        );
        for (const row of rows) {
          validate(row);
          query.run(...columns.map((c) => row[c] as string | number | null));
        }
      };
      upsert("digest_sessions", sessionColumns, ["id"], batch.sessions);
      if (batch.helpers) {
        for (const id of batch.helpers.remove) {
          this.db.connection.prepare(
            "DELETE FROM digest_helpers WHERE session_id=?",
          ).run(id);
        }
        upsert(
          "digest_helpers",
          helperColumns,
          ["session_id"],
          batch.helpers.upsert,
        );
      }
      for (const row of batch.turns.remove) {
        this.db.connection.prepare(
          "DELETE FROM digest_turns WHERE session_id=? AND turn_id=?",
        ).run(row.session_id, row.turn_id);
      }
      upsert(
        "digest_turns",
        turnColumns,
        ["session_id", "turn_id"],
        batch.turns.upsert,
      );
      upsert(
        "digest_bookkeeping",
        bookColumns,
        ["session_id"],
        batch.bookkeeping,
      );
    };
    this.transaction(write);
  }
  markDeleted(
    ids: readonly string[],
    at: number,
    how: "otk" | "provider",
  ): void {
    validate({ at });
    this.db.connection.prepare(
      "UPDATE digest_sessions SET deleted_at=coalesce(deleted_at,?),deleted_how=coalesce(deleted_how,?),revision=revision+1 WHERE id IN (SELECT value FROM json_each(?)) AND deleted_at IS NULL",
    ).run(at, how, JSON.stringify(ids));
  }
  resurrect(ids: readonly string[]): void {
    this.db.connection.prepare(
      "UPDATE digest_sessions SET deleted_at=NULL,deleted_how=NULL,state='digesting',revision=revision+1 WHERE id IN (SELECT value FROM json_each(?)) AND deleted_at IS NOT NULL",
    ).run(JSON.stringify(ids));
  }
  transaction<T>(run: () => T): T {
    // A sink's outer baseline/summary transaction owns commit when present.
    return this.db.connection.isTransaction ? run() : this.db.transaction(run);
  }
}
