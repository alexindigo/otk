// SPDX-License-Identifier: LGPL-3.0-only
import type { DatabaseSync } from "node:sqlite";
/** One native metadata projection, shared by standalone bootstrap and the worker. */
export function runningDirectories(db: DatabaseSync, since: number): string[] {
  return db.prepare(`SELECT DISTINCT s.directory FROM session s
    JOIN message m ON m.id = (SELECT id FROM message WHERE session_id=s.id ORDER BY id DESC LIMIT 1)
    WHERE s.time_updated>=? AND ((json_extract(m.data,'$.role')='assistant' AND json_extract(m.data,'$.time.completed') IS NULL) OR json_extract(m.data,'$.role')='user')`)
    .all(since).map((row) => String(row.directory));
}
