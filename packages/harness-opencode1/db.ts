// SPDX-License-Identifier: LGPL-3.0-only
import { DatabaseSync } from "node:sqlite";
import type { NativeMessage } from "./messages.ts";
import type { Info, RawPart } from "./types.ts";
import type { UsageMessage } from "@otk/protocol";
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
        `harness db: using API fallback: ${(e as Error).message}`,
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
  /** One scalar result, never message/part JSON or transcript content. */
  revertedUserCount(id: string, cutoff: string): number | undefined {
    if (!this.#db) return;
    return Number(
      this.#db.prepare(`
      SELECT count(*) AS count FROM message
      WHERE session_id = ? AND id >= ? AND json_extract(data, '$.role') = 'user'
    `).get(id, cutoff)!.count,
    );
  }
  /** Bounded, metadata-only projections; never hydrate child text/tool output. */
  taskMessages(id: string): Iterable<NativeMessage> | undefined {
    if (!this.#db) return;
    try {
      const messages = this.#db.prepare(`
        SELECT id, json_extract(data, '$.role') AS role,
          json_extract(data, '$.time.created') AS created,
          json_extract(data, '$.time.completed') AS completed
        FROM message WHERE session_id = ? AND id > ? ORDER BY id LIMIT 100
      `);
      const tools = this.#db.prepare(`
        SELECT p.id, p.message_id, json_extract(p.data, '$.tool') AS tool,
          json_extract(p.data, '$.state.status') AS status,
          json_extract(p.data, '$.state.title') AS title,
          json_extract(p.data, '$.state.time.start') AS start,
          json_extract(m.data, '$.time.created') AS created
        FROM part p JOIN message m ON m.id = p.message_id
        WHERE p.session_id = ? AND m.session_id = ? AND p.id > ? AND json_extract(p.data, '$.type') = 'tool'
        ORDER BY p.id LIMIT 100
      `);
      return (function* () {
        let after = "";
        while (true) {
          const rows = messages.all(id, after);
          if (!rows.length) break;
          for (const row of rows) {
            yield {
              info: {
                id: String(row.id),
                sessionID: id,
                agent: "",
                role: row.role as Info["role"],
                time: {
                  created: Number(row.created),
                  ...(row.completed === null
                    ? {}
                    : { completed: Number(row.completed) }),
                },
              },
              parts: [],
            };
          }
          after = String(rows.at(-1)!.id);
        }
        after = "";
        while (true) {
          const rows = tools.all(id, id, after);
          if (!rows.length) break;
          for (const row of rows) {
            yield {
              info: {
                id: String(row.message_id),
                sessionID: id,
                agent: "",
                role: "assistant" as const,
                time: { created: Number(row.created) },
              },
              parts: [{
                id: String(row.id),
                messageID: String(row.message_id),
                sessionID: id,
                type: "tool",
                tool: String(row.tool),
                state: {
                  status: row.status as NonNullable<RawPart["state"]>["status"],
                  input: {},
                  ...(row.title === null ? {} : { title: String(row.title) }),
                  ...(row.start === null
                    ? {}
                    : { time: { start: Number(row.start) } }),
                },
              }],
            };
          }
          after = String(rows.at(-1)!.id);
        }
      })();
    } catch {
      // Older/incompatible schemas keep the bounded stock-API route available.
      return;
    }
  }
  /** Bounded usage headers and existing tool labels; never bodies/inputs/output. */
  usageMessages(id: string): Iterable<UsageMessage> | undefined {
    if (!this.#db) return;
    try {
      const query = this.#db.prepare(`SELECT id,
        json_extract(data, '$.parentID') AS parent,
        json_extract(data, '$.providerID') AS provider,
        json_extract(data, '$.modelID') AS model,
        json_extract(data, '$.tokens') AS tokens,
        json_extract(data, '$.cost') AS cost,
        json_extract(data, '$.time.created') AS created,
        json_extract(data, '$.time.completed') AS completed
        FROM message WHERE session_id = ? AND id > ?
        AND json_extract(data, '$.role') = 'assistant' ORDER BY id LIMIT 100`);
      const tools = this.#db.prepare(`SELECT id,
        json_extract(data, '$.tool') AS name,
        json_extract(data, '$.state.title') AS summary
        FROM part WHERE session_id = ? AND message_id = ? AND id > ?
        AND json_extract(data, '$.type') = 'tool' ORDER BY id LIMIT 100`);
      return (function* () {
        let after = "";
        while (true) {
          const rows = query.all(id, after);
          if (!rows.length) break;
          for (const row of rows) {
            const labels: NonNullable<UsageMessage["tools"]> = [];
            let partAfter = "";
            while (true) {
              const parts = tools.all(id, String(row.id), partAfter);
              if (!parts.length) break;
              for (const part of parts) {
                labels.push({
                  id: String(part.id),
                  name: String(part.name),
                  ...(part.summary == null
                    ? {}
                    : { summary: String(part.summary) }),
                });
              }
              partAfter = String(parts.at(-1)!.id);
            }
            yield {
              id: String(row.id),
              turnID: row.parent == null ? String(row.id) : String(row.parent),
              model: {
                provider: String(row.provider),
                model: String(row.model),
              },
              tokens: row.tokens == null
                ? {
                  input: 0,
                  output: 0,
                  reasoning: 0,
                  cache: { read: 0, write: 0 },
                }
                : JSON.parse(String(row.tokens)),
              cost: Number(row.cost ?? 0),
              completed: row.completed != null,
              time: {
                start: Number(row.created),
                ...(row.completed == null
                  ? {}
                  : { end: Number(row.completed) }),
              },
              tools: labels,
            };
          }
          after = String(rows.at(-1)!.id);
        }
      })();
    } catch {
      return;
    }
  }
  close(): void {
    this.#db?.close();
    this.#db = null;
  }
}
