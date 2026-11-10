// SPDX-License-Identifier: LGPL-3.0-only
import { DatabaseSync } from "node:sqlite";
import type { ProjectSeed, SessionIdentity } from "@otk/harness";
import type { SessionListInput, SessionMetadata } from "@otk/protocol";
import { opencodeV2SessionID as ids } from "./ids.ts";
import type { SessionFacts } from "./metadata.ts";
import { sessionRecencySql } from "./recency.ts";

const required = {
  project: ["id", "worktree"],
  session_v2: [
    "id",
    "project_id",
    "directory",
    "parent_id",
    "time_created",
    "time_updated",
  ],
};
/** Opened only by the existing digest worker. Never creates/migrates native data. */
export class V2NativeDb {
  readonly db: DatabaseSync;
  readonly identity: string;
  readonly columns: Set<string>;
  readonly messageClocks: boolean;
  readonly worktreeColumns: Set<string>;
  constructor(
    readonly file: string,
    readonly observe?: (
      operation: string,
      sample?: { limit: number; rows: number },
    ) => void,
  ) {
    this.identity = this.fileIdentity();
    const db = this.db = new DatabaseSync(file, { readOnly: true });
    try {
      for (const [table, names] of Object.entries(required)) {
        const columns = new Set(
          db.prepare(`PRAGMA table_info(${table})`).all().map((row) =>
            String(row.name)
          ),
        );
        if (names.some((name) => !columns.has(name))) {
          throw new Error(`Incompatible native ${table} schema`);
        }
      }
      this.columns = new Set(
        db.prepare("PRAGMA table_info(session_v2)").all().map((row) =>
          String(row.name)
        ),
      );
      const messages = new Set(
        db.prepare("PRAGMA table_info(session_message)").all().map((row) =>
          String(row.name)
        ),
      );
      this.messageClocks = ["session_id", "seq", "type", "time_created", "data"]
        .every((name) => messages.has(name));
      this.worktreeColumns = new Set(
        db.prepare("PRAGMA table_info(worktree)").all().map((row) =>
          String(row.name)
        ),
      );
    } catch (error) {
      db.close();
      throw error;
    }
  }
  fileIdentity(): string {
    const s = Deno.statSync(this.file);
    return `${s.dev}:${s.ino}:${s.birthtime?.getTime() ?? ""}`;
  }
  dataVersion(): number {
    return Number(this.db.prepare("PRAGMA data_version").get()!.data_version);
  }
  prove(projects: readonly { id: string; canonical: string }[]): boolean {
    this.observe?.("project-proof");
    const rows = this.db.prepare("SELECT id,worktree FROM project ORDER BY id")
      .all();
    return projects.length === rows.length &&
      projects.every((p) =>
        rows.some((r) => r.id === p.id && r.worktree === p.canonical)
      );
  }
  #projection(): string {
    return "s.id,s.parent_id,s.directory,s.project_id,s.time_created,s.time_updated," +
      sessionRecencySql(this.columns, this.messageClocks) +
      " AS activity_time," +
      (this.columns.has("title") ? "s.title" : "NULL AS title") + "," +
      (this.columns.has("time_archived")
        ? "s.time_archived"
        : "NULL AS time_archived");
  }
  /** Optional saved topology, paged in this worker's already source-proven DB. */
  worktrees(
    projectID: string,
    after: string,
    limit: number,
  ): { directory: string; strategy?: string }[] | undefined {
    if (
      !["project_id", "directory"].every((name) =>
        this.worktreeColumns.has(name)
      )
    ) return;
    this.observe?.("worktree-inventory");
    const strategy = this.worktreeColumns.has("strategy")
      ? "strategy"
      : "NULL AS strategy";
    return this.db.prepare(
      `SELECT directory,${strategy} FROM worktree WHERE project_id=? AND directory>? ORDER BY directory LIMIT ?`,
    ).all(projectID, after, limit).map((row) => ({
      directory: String(row.directory),
      ...(typeof row.strategy === "string" ? { strategy: row.strategy } : {}),
    }));
  }
  #metadata(row: Record<string, unknown>): SessionMetadata {
    return {
      id: ids.encode(String(row.id)),
      directory: String(row.directory),
      projectID: String(row.project_id),
      ...(row.parent_id == null
        ? {}
        : { parentID: ids.encode(String(row.parent_id)) }),
      title: row.title == null ? "Untitled session" : String(row.title),
      timeCreated: Number(row.time_created),
      timeUpdated: Number(row.activity_time),
      archived: row.time_archived != null,
      status: "idle",
      activityAuthority: "unknown",
      attention: {
        permissions: 0,
        questions: 0,
        childPermissions: 0,
        childQuestions: 0,
      },
    };
  }
  lookup(keys: readonly string[]): SessionMetadata[] {
    this.observe?.("identity");
    return this.db.prepare(
      `SELECT ${this.#projection()} FROM session_v2 s JOIN json_each(?) wanted ON s.id=wanted.value ORDER BY s.id`,
    )
      .all(JSON.stringify([...new Set(keys.map(ids.decode))])).map((row) =>
        this.#metadata(row)
      );
  }
  facts(keys: readonly string[]): SessionFacts[] {
    this.observe?.("session-facts");
    const optional = ["time_busy", "time_idle", "idle_outcome"].map((name) =>
      this.columns.has(name) ? `s.${name}` : `NULL AS ${name}`
    ).join(",");
    return this.db.prepare(
      `SELECT ${this.#projection()},${optional} FROM session_v2 s JOIN json_each(?) wanted ON s.id=wanted.value ORDER BY s.id`,
    )
      .all(JSON.stringify([...new Set(keys.map(ids.decode))])).map((row) => ({
        id: String(row.id),
        projectID: String(row.project_id),
        activity: Number(row.activity_time),
        location: { directory: String(row.directory) },
        ...(row.title == null ? {} : { title: String(row.title) }),
        ...(row.parent_id == null ? {} : { parentID: String(row.parent_id) }),
        time: {
          created: Number(row.time_created),
          updated: Number(row.time_updated),
          ...(row.time_archived == null
            ? {}
            : { archived: Number(row.time_archived) }),
          ...(row.time_busy == null ? {} : { busy: Number(row.time_busy) }),
          ...(row.time_idle == null ? {} : { idle: Number(row.time_idle) }),
        },
        ...(["succeeded", "failed", "interrupted"].includes(
            String(row.idle_outcome),
          )
          ? { outcome: row.idle_outcome as SessionFacts["outcome"] }
          : {}),
      }));
  }
  identities(keys: readonly string[]): SessionIdentity[] {
    this.observe?.("identities");
    return this.db.prepare(
      "SELECT s.id,s.directory,s.parent_id FROM session_v2 s JOIN json_each(?) wanted ON s.id=wanted.value ORDER BY s.id",
    )
      .all(JSON.stringify([...new Set(keys.map(ids.decode))])).map((row) => ({
        id: ids.encode(String(row.id)),
        directory: String(row.directory),
        ...(row.parent_id == null
          ? {}
          : { parentID: ids.encode(String(row.parent_id)) }),
      }));
  }
  projects(
    after: string,
    limit: number,
    directory?: string,
  ): (ProjectSeed & { projectID?: string })[] {
    this.observe?.("project-seeds");
    return this.db.prepare(
      `SELECT directory,CASE WHEN COUNT(*)=1 THEN MIN(project_id) END AS project_id,SUM(count) AS count,MAX(latest) AS latest FROM (SELECT project_id,directory,COUNT(*) AS count,MAX(${
        sessionRecencySql(this.columns, this.messageClocks)
      }) AS latest FROM session_v2 s WHERE directory>? ${
        directory === undefined ? "" : "AND directory=?"
      } GROUP BY project_id,directory) GROUP BY directory ORDER BY directory LIMIT ?`,
    )
      .all(
        ...(directory === undefined
          ? [after, limit]
          : [after, directory, limit]),
      ).map((row) => ({
        ...(row.project_id == null
          ? {}
          : { projectID: String(row.project_id) }),
        directory: String(row.directory),
        hasSessions: true,
        sessionCount: Number(row.count),
        lastActivity: Number(row.latest),
        authority: "current" as const,
      }));
  }
  list(
    input: SessionListInput,
    before: { updated: number; id: string } | undefined,
    limit: number,
  ): SessionMetadata[] {
    const filters = ["s.directory=?"],
      values: (string | number | null)[] = [input.directory];
    if (input.parentID !== undefined) {
      filters.push("s.parent_id IS ?");
      values.push(input.parentID === null ? null : ids.decode(input.parentID));
    }
    if (input.query) {
      filters.push(
        this.columns.has("title")
          ? "instr(lower(s.title),lower(?))>0"
          : "0 AND ? IS NOT NULL",
      );
      values.push(input.query);
    }
    if (before) {
      filters.push(
        `(${sessionRecencySql(this.columns, this.messageClocks)},s.id)<(?,?)`,
      );
      values.push(before.updated, before.id);
    }
    const rows = this.db.prepare(
      `SELECT ${this.#projection()} FROM session_v2 s WHERE ${
        filters.join(" AND ")
      } ORDER BY ${
        sessionRecencySql(this.columns, this.messageClocks)
      } DESC,s.id DESC LIMIT ?`,
    ).all(...values, limit).map((row) => this.#metadata(row));
    this.observe?.("session-list", { limit, rows: rows.length });
    return rows;
  }
  close(): void {
    this.db.close();
  }
  recent(
    directories: readonly string[],
    before: { updated: number; id: string } | undefined,
    limit: number,
  ): SessionMetadata[] {
    const rows = this.db.prepare(
      `SELECT ${this.#projection()} FROM session_v2 s WHERE s.directory IN (SELECT value FROM json_each(?)) AND (? IS NULL OR (s.time_updated,s.id)<(?,?)) ORDER BY s.time_updated DESC,s.id DESC LIMIT ?`,
    ).all(
      JSON.stringify(directories),
      before?.updated ?? null,
      before?.updated ?? null,
      before?.id ?? null,
      limit,
    ).map((row) => this.#metadata(row));
    this.observe?.("session-discovery", { limit, rows: rows.length });
    return rows;
  }
  /** Legacy rows retained by native migration prove origin, not just an ID prefix. */
  upgrade(
    keys: readonly string[],
  ): string[] {
    const columns = new Set(
      this.db.prepare("PRAGMA table_info(session)").all().map((row) =>
        String(row.name)
      ),
    );
    if (
      ["id", "directory", "time_created"].some((name) => !columns.has(name))
    ) return [];
    this.observe?.("upgrade-proof");
    return this.db.prepare(
      "SELECT v.id FROM session_v2 v JOIN session old ON old.id=v.id AND old.time_created=v.time_created AND old.directory=v.directory JOIN json_each(?) wanted ON wanted.value=v.id ORDER BY v.id",
    )
      .all(JSON.stringify(keys)).map((row) => String(row.id));
  }
}
