// SPDX-License-Identifier: LGPL-3.0-only
import { DatabaseSync } from "node:sqlite";
import type { SessionMetadata } from "@otk/protocol";
import type { SessionIdentity } from "@otk/harness";
import { opencodeV1SessionID as ids } from "./ids.ts";
import { runningDirectories } from "./db-hints.ts";

/** Allowlisted message header projection. Native identities stay native here. */
export interface DigestHeader {
  timing_json?: string | null;
  variant?: string | null;
  session_id: string;
  message_id: string;
  role: "user" | "assistant";
  turn_id: string | null;
  time_created: number;
  time_completed: number | null;
  terminal?: number;
  agent: string | null;
  provider_id: string | null;
  model_id: string | null;
  cost: number | null;
  input: number | null;
  output: number | null;
  reasoning: number | null;
  cache_read: number | null;
  cache_write: number | null;
}
const projection = [
  ["role", "role"],
  ["parentID", "turn_id"],
  ["time.created", "time_created"],
  ["time.completed", "time_completed"],
  ["agent", "agent"],
  ["model.variant", "variant"],
  ["providerID", "provider_id"],
  ["modelID", "model_id"],
  ["cost", "cost"],
  ["tokens.input", "input"],
  ["tokens.output", "output"],
  ["tokens.reasoning", "reasoning"],
  ["tokens.cache.read", "cache_read"],
  ["tokens.cache.write", "cache_write"],
].map(([path, alias]) =>
  alias === "time_created"
    ? "m.time_created AS time_created"
    : `CASE WHEN json_valid(m.data) THEN json_extract(m.data,'$.${path}') END AS ${alias}`
).join(",") +
  ",CASE WHEN json_valid(m.data) AND (json_extract(m.data,'$.error') IS NOT NULL OR (json_extract(m.data,'$.finish') IS NOT NULL AND json_extract(m.data,'$.finish') NOT IN ('tool-calls','unknown'))) THEN 1 ELSE 0 END AS terminal" +
  ",(SELECT json_group_array(json_object('type',json_extract(p.data,'$.type'),'name',json_extract(p.data,'$.tool'),'start',CASE WHEN json_extract(p.data,'$.type')='tool' THEN json_extract(p.data,'$.state.time.start') ELSE json_extract(p.data,'$.time.start') END,'end',CASE WHEN json_extract(p.data,'$.type')='tool' THEN json_extract(p.data,'$.state.time.end') ELSE json_extract(p.data,'$.time.end') END)) FROM part p WHERE p.session_id=m.session_id AND p.message_id=m.id AND json_valid(p.data) AND json_extract(p.data,'$.type') IN ('text','reasoning','tool','retry')) AS timing_json";
const terminalProjection = (session = "session") =>
  `(SELECT CASE WHEN json_extract(m.data,'$.error') IS NOT NULL THEN coalesce(json_extract(m.data,'$.time.completed'),m.time_created) WHEN json_extract(m.data,'$.finish') IS NOT NULL AND json_extract(m.data,'$.finish') NOT IN ('tool-calls','unknown') THEN json_extract(m.data,'$.time.completed') END FROM message m WHERE m.session_id=${session}.id AND json_valid(m.data) AND json_extract(m.data,'$.role')='assistant' ORDER BY m.time_created DESC,m.id DESC LIMIT 1) AS terminal`;

function metadata(row: Record<string, unknown>): SessionMetadata {
  return {
    id: ids.encode(String(row.id)),
    ...(row.parent_id == null
      ? {}
      : { parentID: ids.encode(String(row.parent_id)) }),
    directory: String(row.directory),
    projectID: String(row.project_id),
    title: String(row.title),
    timeCreated: Number(row.time_created),
    timeUpdated: Number(row.time_updated),
    archived: row.time_archived != null,
    status: "idle",
    activity: {
      terminal: Number(row.terminal) > 0 ? Number(row.terminal) : undefined,
    },
    attention: {
      permissions: 0,
      questions: 0,
      childPermissions: 0,
      childQuestions: 0,
    },
  };
}

/** Read-only native connection. No full JSON or transcript parts escape its SQL. */
export class DigestNativeDb {
  readonly db: DatabaseSync;
  readonly identity: string;
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
      for (
        const [table, names] of Object.entries({
          session: [
            "id",
            "parent_id",
            "directory",
            "project_id",
            "title",
            "time_created",
            "time_updated",
            "time_archived",
          ],
          message: ["id", "session_id", "data"],
          part: ["id", "message_id", "session_id", "data"],
        })
      ) {
        const columns = new Set(
          db.prepare(`PRAGMA table_info(${table})`).all().map((row) =>
            row.name
          ),
        );
        if (names.some((name) => !columns.has(name))) {
          throw new Error(`Incompatible native ${table} schema`);
        }
      }
    } catch (error) {
      db.close();
      throw error;
    }
  }
  fileIdentity(): string {
    const stat = Deno.statSync(this.file);
    return `${stat.dev}:${stat.ino}:${stat.birthtime?.getTime() ?? ""}`;
  }
  hints(sessions: readonly string[]): string[] {
    this.observe?.("hints");
    return runningDirectories(this.db, 0, sessions.map(ids.decode));
  }
  catalog(after: string, limit: number): SessionMetadata[] {
    this.observe?.("catalog");
    return this.db.prepare(
      `SELECT id,parent_id,directory,project_id,title,time_created,time_updated,time_archived,${terminalProjection()} FROM session WHERE id>? ORDER BY id LIMIT ?`,
    ).all(after, limit).map(metadata);
  }
  /** Ownership proofs read the API's current identities, not an older paged list. */
  listSessions(
    input: import("@otk/protocol").SessionListInput,
    before: { updated: number; id: string } | undefined,
    limit: number,
  ): SessionMetadata[] {
    const filters = typeof input.parentID === "string" ? [] : ["directory=?"],
      values: (string | number | null)[] = typeof input.parentID === "string"
        ? []
        : [input.directory];
    if (input.parentID !== undefined) {
      filters.push("parent_id IS ?");
      values.push(input.parentID === null ? null : ids.decode(input.parentID));
    }
    if (input.query) {
      filters.push("instr(lower(title),lower(?))>0");
      values.push(input.query);
    }
    if (before) {
      filters.push("(time_updated,id)<(?,?)");
      values.push(before.updated, before.id);
    }
    const rows = this.db.prepare(
      `SELECT id,parent_id,directory,project_id,title,time_created,time_updated,time_archived,${terminalProjection()} FROM session WHERE ${
        filters.join(" AND ")
      } ORDER BY time_updated DESC,id DESC LIMIT ?`,
    ).all(...values, limit).map(metadata);
    this.observe?.("session-list", { limit, rows: rows.length });
    return rows;
  }
  /** Ownership proofs read the API's current identities, not an older paged list. */
  identities(sessions: readonly string[]): SessionIdentity[] {
    if (!sessions.length) return [];
    this.observe?.("identities");
    return this.db.prepare(
      "SELECT s.id,s.directory,s.parent_id FROM session s JOIN json_each(?) wanted ON s.id=wanted.value ORDER BY s.id",
    ).all(JSON.stringify([...new Set(sessions.map(ids.decode))])).map((
      row,
    ) => ({
      id: ids.encode(String(row.id)),
      directory: String(row.directory),
      ...(row.parent_id == null
        ? {}
        : { parentID: ids.encode(String(row.parent_id)) }),
    }));
  }
  recent(
    directories: readonly string[],
    before: { updated: number; id: string } | undefined,
    limit: number,
  ): SessionMetadata[] {
    const rows = this.db.prepare(
      `SELECT id,parent_id,directory,project_id,title,time_created,time_updated,time_archived,${terminalProjection()} FROM session WHERE directory IN (SELECT value FROM json_each(?)) AND (? IS NULL OR (time_updated,id)<(?,?)) ORDER BY time_updated DESC,id DESC LIMIT ?`,
    ).all(
      JSON.stringify(directories),
      before?.updated ?? null,
      before?.updated ?? null,
      before?.id ?? null,
      limit,
    ).map(metadata);
    this.observe?.("session-discovery", { limit, rows: rows.length });
    return rows;
  }
  lookup(sessions: readonly string[]): SessionMetadata[] {
    this.observe?.("identity");
    return this.db.prepare(
      `SELECT s.id,s.parent_id,s.directory,s.project_id,s.title,s.time_created,s.time_updated,s.time_archived,${
        terminalProjection("s")
      } FROM session s JOIN json_each(?) wanted ON wanted.value=s.id ORDER BY s.id`,
    ).all(JSON.stringify(sessions.map(ids.decode))).map(metadata);
  }
  /** Bounded identity proof; malformed or unreported headers are never empty. */
  emptySessions(sessions: readonly string[]): string[] {
    this.observe?.("empty");
    return this.db.prepare(
      "SELECT s.id FROM session s JOIN json_each(?) wanted ON wanted.value=s.id WHERE NOT EXISTS(SELECT 1 FROM message m WHERE m.session_id=s.id) ORDER BY s.id",
    ).all(JSON.stringify(sessions.map(ids.decode))).map((row) =>
      ids.encode(String(row.id))
    );
  }
  /** Keyset scan across a batch; one query, zero part queries. */
  headers(
    sessions: readonly string[],
    _afterSession: string,
    afterMessage: string,
    limit: number,
    position?: import("@otk/harness").DigestBoundary,
    boundary?: import("@otk/harness").DigestBoundary,
  ): DigestHeader[] {
    const filters = [
      sessions.length === 1
        ? "m.session_id=?"
        : "m.session_id IN (SELECT value FROM json_each(?))",
    ];
    const values: (string | number)[] = [
      sessions.length === 1
        ? ids.decode(sessions[0])
        : JSON.stringify(sessions.map(ids.decode)),
    ];
    if (position) {
      filters.push("(m.time_created,m.id)<(?,?)");
      values.push(position.created, position.messageID);
    } else if (afterMessage) {
      // Public consumers may still supply only the last native identity. Resolve
      // its collection clock in this same query, never one extra query per slice.
      filters.push(
        "(m.time_created,m.id)<((SELECT time_created FROM message WHERE session_id=? AND id=?),?)",
      );
      values.push(ids.decode(sessions[0]), afterMessage, afterMessage);
    }
    if (boundary) {
      filters.push("(m.time_created,m.id)>=(?,?)");
      values.push(boundary.created, boundary.messageID);
    }
    const rows = this.db.prepare(
      `SELECT m.session_id,m.id AS message_id,${projection} FROM message m WHERE ${
        filters.join(" AND ")
      } ORDER BY m.time_created DESC,m.id DESC LIMIT ?`,
    ).all(...values, limit) as unknown as DigestHeader[];
    this.observe?.("headers", { limit, rows: rows.length });
    return rows;
  }
  replacements(
    keys: { sessionID: string; messageID: string }[],
  ): DigestHeader[] {
    this.observe?.("replacements");
    return this.db.prepare(
      `SELECT m.session_id,m.id AS message_id,${projection} FROM message m JOIN json_each(?) wanted ON json_extract(wanted.value,'$.session')=m.session_id AND json_extract(wanted.value,'$.message')=m.id ORDER BY m.session_id,m.id`,
    ).all(
      JSON.stringify(
        keys.map((key) => ({
          session: ids.decode(key.sessionID),
          message: key.messageID,
        })),
      ),
    ) as unknown as DigestHeader[];
  }
  tools(
    sessionID: string,
    messages: string[],
    after: string,
    limit: number,
  ): {
    id: string;
    message_id: string;
    name: string;
    summary: string | null;
  }[] {
    this.observe?.("tools");
    return this.db.prepare(
      `SELECT p.id,p.message_id,json_extract(p.data,'$.tool') AS name,json_extract(p.data,'$.state.title') AS summary FROM part p JOIN json_each(?) wanted ON wanted.value=p.message_id WHERE p.session_id=? AND p.id>? AND json_valid(p.data) AND json_extract(p.data,'$.type')='tool' ORDER BY p.id LIMIT ?`,
    ).all(
      JSON.stringify(messages),
      ids.decode(sessionID),
      after,
      limit,
    ) as unknown as {
      id: string;
      message_id: string;
      name: string;
      summary: string | null;
    }[];
  }
  helperTools(
    sessions: readonly string[],
    afterSession: string,
    afterPart: string,
    limit: number,
    messages?: readonly string[],
  ): HelperToolRow[] {
    this.observe?.("helpers");
    return this.db.prepare(`SELECT p.session_id,p.message_id,p.id AS part_id,
      CASE WHEN json_valid(p.data) THEN json_extract(p.data,'$.tool') END AS name,
      CASE WHEN json_valid(p.data) THEN json_extract(p.data,'$.state.title') END AS title,
      CASE WHEN json_valid(p.data) THEN json_extract(p.data,'$.state.status') END AS status,
      CASE WHEN json_valid(p.data) THEN json_extract(p.data,'$.state.time.start') END AS time_start,
      CASE WHEN json_valid(m.data) THEN json_extract(m.data,'$.time.created') END AS message_created
      FROM part p JOIN message m ON m.id=p.message_id AND m.session_id=p.session_id
      JOIN json_each(?) wanted ON wanted.value=p.session_id
      WHERE (p.session_id,p.id)>(?,?) AND (? IS NULL OR p.message_id IN (SELECT value FROM json_each(?))) AND (NOT json_valid(p.data) OR NOT json_valid(m.data) OR CASE WHEN json_valid(p.data) THEN json_extract(p.data,'$.type')='tool' ELSE 0 END)
      ORDER BY p.session_id,p.id LIMIT ?`).all(
      JSON.stringify(sessions.map(ids.decode)),
      afterSession,
      afterPart,
      messages === undefined ? null : JSON.stringify(messages),
      messages === undefined ? null : JSON.stringify(messages),
      limit,
    ) as unknown as HelperToolRow[];
  }
  close(): void {
    this.db.close();
  }
  transcriptMetadata(
    sessionID: string,
    turns: readonly string[],
    cutoff?: string,
  ): import("@otk/harness").TranscriptMetadata {
    this.observe?.("transcript");
    const session = ids.decode(sessionID);
    const prompt = this.db.prepare(
      "SELECT id,json_extract(data,'$.agent') AS agent,json_extract(data,'$.model.providerID') AS provider,json_extract(data,'$.model.modelID') AS model,json_extract(data,'$.model.variant') AS variant FROM message WHERE session_id=? AND (? IS NULL OR id<?) AND json_valid(data) AND json_extract(data,'$.role')='user' ORDER BY json_extract(data,'$.time.created') DESC,id DESC LIMIT 1",
    ).get(session, cutoff ?? null, cutoff ?? null);
    const rows = this.db.prepare(
      "WITH headers AS (SELECT m.id,coalesce(json_extract(m.data,'$.parentID'),m.id) AS turn,json_extract(m.data,'$.time.created') AS created,json_extract(m.data,'$.time.completed') AS completed FROM message m JOIN json_each(?) wanted ON wanted.value=coalesce(json_extract(m.data,'$.parentID'),m.id) WHERE m.session_id=? AND (? IS NULL OR m.id<?) AND json_valid(m.data) AND json_extract(m.data,'$.role')='assistant'), ranked AS (SELECT *,row_number() OVER(PARTITION BY turn ORDER BY created,id) AS first_rank,row_number() OVER(PARTITION BY turn ORDER BY created DESC,id DESC) AS last_rank FROM headers) SELECT turn,max(CASE WHEN first_rank=1 THEN id END) AS first_id,max(CASE WHEN last_rank=1 THEN id END) AS last_id,min(completed IS NOT NULL) AS complete FROM ranked GROUP BY turn",
    ).all(JSON.stringify(turns), session, cutoff ?? null, cutoff ?? null);
    const boundaries = new Map<string, import("@otk/protocol").ReplyBoundary>();
    for (const row of rows) {
      const turnID = String(row.turn);
      boundaries.set(turnID, {
        turnID,
        firstID: String(row.first_id),
        lastID: String(row.last_id),
        complete: row.complete === 1,
      });
    }
    const boundary = cutoff &&
      this.db.prepare(
        "SELECT json_extract(data,'$.time.created') AS created FROM message WHERE session_id=? AND id=? AND json_valid(data)",
      ).get(session, cutoff);
    return {
      ...(prompt
        ? {
          prompt: {
            id: String(prompt.id),
            ...(typeof prompt.agent === "string"
              ? { agent: prompt.agent }
              : {}),
            ...(typeof prompt.provider === "string" &&
                typeof prompt.model === "string"
              ? { model: { provider: prompt.provider, model: prompt.model } }
              : {}),
            ...(typeof prompt.variant === "string"
              ? { variant: prompt.variant }
              : {}),
          },
        }
        : {}),
      boundaries: [...boundaries.values()],
      ...(boundary && typeof boundary.created === "number"
        ? { cutoffCreated: boundary.created }
        : {}),
    };
  }
}
export interface HelperToolRow {
  session_id: string;
  message_id: string;
  part_id: string;
  name: string;
  title: string | null;
  status: string;
  time_start: number | null;
  message_created: number;
}
