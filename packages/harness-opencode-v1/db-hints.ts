// SPDX-License-Identifier: LGPL-3.0-only
import type { DatabaseSync } from "node:sqlite";
import type { SessionMetadata } from "@otk/protocol";
import type { Info } from "./types.ts";
import { opencodeV1SessionID as ids } from "./ids.ts";

/** Completion/error is terminal evidence; an unfinished latest call is not. */
export function terminalToken(info: Info): number {
  return info.role === "assistant" &&
      (info.error || !["tool-calls", "unknown"].includes(info.finish ?? ""))
    ? info.time.completed ?? (info.error ? info.time.created : 0)
    : 0;
}
export const terminalProjection = (session = "session") =>
  `(SELECT CASE WHEN json_extract(m.data,'$.error') IS NOT NULL THEN coalesce(json_extract(m.data,'$.time.completed'),m.time_created) ELSE json_extract(m.data,'$.time.completed') END FROM message m WHERE m.session_id=${session}.id AND json_valid(m.data) AND json_extract(m.data,'$.role')='assistant' AND (json_extract(m.data,'$.error') IS NOT NULL OR (json_extract(m.data,'$.time.completed')>0 AND coalesce(json_extract(m.data,'$.finish'),'') NOT IN ('tool-calls','unknown'))) ORDER BY m.time_created DESC,m.id DESC LIMIT 1) AS terminal`;

export function nativeMetadata(row: Record<string, unknown>): SessionMetadata {
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

/** Bounded positive terminal inventory, never bodies or unfinished candidates. */
export function terminalSessions(
  db: DatabaseSync,
  after: string,
  limit: number,
): SessionMetadata[] {
  return db.prepare(
    `SELECT * FROM (SELECT s.id,s.parent_id,s.directory,s.project_id,s.title,s.time_created,s.time_updated,s.time_archived,${
      terminalProjection("s")
    } FROM session s WHERE s.id>?) WHERE terminal>0 ORDER BY id LIMIT ?`,
  ).all(after ? ids.decode(after) : "", limit).map((row) => ({
    ...nativeMetadata(row),
    activity: { terminal: Number(row.terminal) },
  }));
}
/** One native metadata projection, shared by standalone bootstrap and the worker. */
export function runningDirectories(
  db: DatabaseSync,
  since: number,
  sessions?: readonly string[],
): string[] {
  return db.prepare(`SELECT DISTINCT s.directory FROM session s
    JOIN message m ON m.id = (SELECT id FROM message WHERE session_id=s.id ORDER BY id DESC LIMIT 1)
    WHERE s.time_updated>=? ${
    sessions ? "AND s.id IN (SELECT value FROM json_each(?))" : ""
  } AND ((json_extract(m.data,'$.role')='assistant' AND json_extract(m.data,'$.time.completed') IS NULL) OR json_extract(m.data,'$.role')='user')`)
    .all(...(sessions ? [since, JSON.stringify(sessions)] : [since])).map((
      row,
    ) => String(row.directory));
}
