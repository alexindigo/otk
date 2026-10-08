// SPDX-License-Identifier: LGPL-3.0-only
import { DatabaseSync } from "node:sqlite";
/** Never creates or writes the harness database; schema checks name query columns. */
export class BootstrapDb {
  #db: DatabaseSync | null = null;
  constructor(readonly file: string) {
    try {
      this.#db = new DatabaseSync(file, { readOnly: true });
      const required = {
        session: ["id", "directory", "time_updated"],
        message: ["id", "session_id", "data"],
      };
      for (const [table, names] of Object.entries(required)) {
        const columns = new Set(
          this.#db.prepare(`PRAGMA table_info(${table})`).all().map((r) =>
            r.name
          ),
        );
        const missing = names.filter((name) => !columns.has(name));
        if (missing.length) {
          throw new Error(`${table}: missing ${missing.join(", ")}`);
        }
      }
    } catch (e) {
      this.close();
      console.warn(
        `harness db: degraded bootstrap (events only): ${(e as Error).message}`,
      );
    }
  }
  possiblyRunningDirectories(since: number): string[] {
    if (!this.#db) return [];
    const rows = this.#db.prepare(`
      SELECT DISTINCT s.directory FROM session s
      JOIN message m ON m.id = (SELECT id FROM message WHERE session_id = s.id ORDER BY id DESC LIMIT 1)
      WHERE s.time_updated >= ? AND (
        (json_extract(m.data, '$.role') = 'assistant' AND json_extract(m.data, '$.time.completed') IS NULL)
        OR json_extract(m.data, '$.role') = 'user'
      )
    `).all(since);
    return rows.map((r) => String(r.directory));
  }
  close(): void {
    this.#db?.close();
    this.#db = null;
  }
}
