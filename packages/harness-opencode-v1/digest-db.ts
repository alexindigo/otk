// SPDX-License-Identifier: LGPL-3.0-only
import { DatabaseSync } from "node:sqlite";
import type { SessionMetadata } from "@otk/protocol";
import { opencodeV1SessionID as ids } from "./ids.ts";
import { runningDirectories } from "./db-hints.ts";

/** Allowlisted message header projection. Native identities stay native here. */
export interface DigestHeader {
  session_id: string;
  message_id: string;
  role: "user" | "assistant";
  turn_id: string | null;
  time_created: number;
  time_completed: number | null;
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
  ["providerID", "provider_id"],
  ["modelID", "model_id"],
  ["cost", "cost"],
  ["tokens.input", "input"],
  ["tokens.output", "output"],
  ["tokens.reasoning", "reasoning"],
  ["tokens.cache.read", "cache_read"],
  ["tokens.cache.write", "cache_write"],
].map(([path, alias]) =>
  `CASE WHEN json_valid(m.data) THEN json_extract(m.data,'$.${path}') END AS ${alias}`
).join(",");

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
    readonly observe?: (operation: string) => void,
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
  hints(): string[] {
    this.observe?.("hints");
    return runningDirectories(this.db, 0);
  }
  catalog(after: string, limit: number): SessionMetadata[] {
    this.observe?.("catalog");
    return this.db.prepare(
      `SELECT id,parent_id,directory,project_id,title,time_created,time_updated,time_archived FROM session WHERE id>? ORDER BY id LIMIT ?`,
    ).all(after, limit).map(metadata);
  }
  /** Ownership proofs read the API's current identities, not an older paged list. */
  lookup(sessions: readonly string[]): SessionMetadata[] {
    this.observe?.("identity");
    return this.db.prepare(
      "SELECT s.id,s.parent_id,s.directory,s.project_id,s.title,s.time_created,s.time_updated,s.time_archived FROM session s JOIN json_each(?) wanted ON wanted.value=s.id ORDER BY s.id",
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
    afterSession: string,
    afterMessage: string,
    limit: number,
  ): DigestHeader[] {
    this.observe?.("headers");
    return this.db.prepare(
      `SELECT m.session_id,m.id AS message_id,${projection} FROM message m JOIN json_each(?) wanted ON wanted.value=m.session_id WHERE (m.session_id,m.id)>(?,?) ORDER BY m.session_id,m.id LIMIT ?`,
    ).all(
      JSON.stringify(sessions.map(ids.decode)),
      afterSession,
      afterMessage,
      limit,
    ) as unknown as DigestHeader[];
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
  close(): void {
    this.db.close();
  }
}
