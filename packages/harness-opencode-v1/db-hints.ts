// SPDX-License-Identifier: LGPL-3.0-only
import type { DatabaseSync } from "node:sqlite";
import type { SessionMetadata, TerminalEvidence } from "@otk/protocol";
import type { Info } from "./types.ts";
import { opencodeV1SessionID as ids } from "./ids.ts";

/** Completion/error is terminal evidence; an unfinished latest call is not. */
export function terminalToken(info: Info): number {
  return info.role === "assistant" &&
      (info.error || !["tool-calls", "unknown"].includes(info.finish ?? ""))
    ? info.time.completed ?? (info.error ? info.time.created : 0)
    : 0;
}
const terminalClock =
  "CASE WHEN json_extract(m.data,'$.error') IS NOT NULL THEN coalesce(json_extract(m.data,'$.time.completed'),m.time_created) ELSE json_extract(m.data,'$.time.completed') END";
const terminalRows = (session: string) =>
  `FROM message m WHERE m.session_id=${session}.id AND json_valid(m.data) AND json_extract(m.data,'$.role')='assistant' AND (json_extract(m.data,'$.error') IS NOT NULL OR (json_extract(m.data,'$.time.completed')>0 AND coalesce(json_extract(m.data,'$.finish'),'') NOT IN ('tool-calls','unknown')))`;
const latest = (session: string, expression: string) =>
  `(SELECT ${expression} ${
    terminalRows(session)
  } ORDER BY m.time_created DESC,m.id DESC LIMIT 1)`;
export const terminalProjection = (session = "session") =>
  `${latest(session, terminalClock)} AS terminal`;
export function terminalFacts(info: Info): TerminalEvidence {
  const terminal = terminalToken(info);
  return terminal
    ? {
      terminal,
      runID: info.id,
      outcome: info.error
        ? info.error.name === "MessageAbortedError" ? "interrupted" : "failed"
        : "succeeded",
    }
    : {};
}
const outcomeProjection = (session: string) =>
  `${
    latest(
      session,
      "CASE WHEN json_extract(m.data,'$.error.name')='MessageAbortedError' THEN 'interrupted' WHEN json_extract(m.data,'$.error') IS NOT NULL THEN 'failed' ELSE 'succeeded' END",
    )
  } AS terminal_outcome`;

export function nativeMetadata(row: Record<string, unknown>): SessionMetadata {
  return {
    id: ids.encode(String(row.id)),
    ...(row.parent_id == null
      ? {}
      : { parentID: ids.encode(String(row.parent_id)) }),
    directory: String(row.directory),
    projectID: String(row.project_id),
    title: String(row.title),
    ...(row.agent == null ? {} : { agent: String(row.agent) }),
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

/** Older V1 databases do not record an agent on the session. */
export function sessionProjection(db: DatabaseSync): string {
  const agent =
    db.prepare("PRAGMA table_info(session)").all().some((row) =>
        row.name === "agent"
      )
      ? "s.agent"
      : "NULL AS agent";
  return `s.id,s.parent_id,s.directory,s.project_id,s.title,s.time_created,s.time_updated,s.time_archived,${agent},${
    terminalProjection("s")
  }`;
}

/** Bounded positive terminal inventory, never bodies or unfinished candidates. */
export function terminalSessions(
  db: DatabaseSync,
  after: string,
  limit: number,
): SessionMetadata[] {
  return db.prepare(
    `SELECT selected.*, (SELECT count(*) FROM (SELECT 1 ${
      terminalRows("selected")
    }
       AND (${terminalClock})=selected.terminal LIMIT 2)) AS terminal_matches
     FROM (SELECT ${sessionProjection(db)},${outcomeProjection("s")},${
      latest("s", "m.id")
    } AS run_id FROM session s WHERE s.id>? AND ${
      latest("s", terminalClock)
    }>0 ORDER BY s.id LIMIT ?) selected`,
  ).all(after ? ids.decode(after) : "", limit).map((row) => ({
    ...nativeMetadata(row),
    activity: {
      terminal: Number(row.terminal),
      ...(typeof row.run_id === "string" && row.run_id
        ? {
          runID: row.run_id,
          legacyAcknowledgement: Number(row.terminal_matches) === 1
            ? { terminal: Number(row.terminal), runID: row.run_id }
            : null,
        }
        : {}),
      outcome: row.terminal_outcome as import("@otk/protocol").TerminalOutcome,
      terminalOrigin: "historical",
    },
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
