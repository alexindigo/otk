// SPDX-License-Identifier: LGPL-3.0-only
import type { DiagnosticSink } from "@otk/protocol";
import { DatabaseSync } from "node:sqlite";
import type { NativeMessage } from "./messages.ts";
import type { Info, RawPart } from "./types.ts";
import type { UsageMessage } from "@otk/protocol";
import { reportedNumber, reportedTokens } from "./usage-values.ts";
import { opencodeV1SessionID as ids } from "./ids.ts";
import { runningDirectories, terminalSessions } from "./db-hints.ts";
/** Never creates or writes the harness database; schema checks name query columns. */
export class BootstrapDb {
  #db: DatabaseSync | null = null;
  constructor(
    readonly file: string,
    readonly diagnostic: DiagnosticSink = () => {},
  ) {
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
      this.diagnostic("warn", "harness db: using API fallback", e);
    }
  }
  /** Candidate endpoints, qualified by the adapter's current native status. */
  terminals(
    after: string,
    limit: number,
  ): import("@otk/protocol").SessionMetadata[] {
    if (!this.#db) return [];
    try {
      return terminalSessions(this.#db, after, limit);
    } catch (error) {
      this.diagnostic(
        "warn",
        "harness db: terminal evidence unavailable",
        error,
      );
      return [];
    }
  }
  /** Undefined means hints are unavailable; an empty list is authoritative. */
  possiblyRunningDirectories(since: number): string[] | undefined {
    if (!this.#db) return;
    try {
      return runningDirectories(this.#db, since);
    } catch (error) {
      this.diagnostic("warn", "harness db: using API fallback", error);
      return;
    }
  }
  async activityCandidates(
    since: number,
    rows: number,
    signal: AbortSignal,
  ): Promise<string[] | undefined> {
    if (!this.#db) return;
    try {
      const directories = new Set<string>();
      let after = "";
      for (;;) {
        signal.throwIfAborted();
        const page = this.#db.prepare(
          "SELECT id FROM session WHERE id>? ORDER BY id LIMIT ?",
        ).all(after, rows).map((row) => String(row.id));
        if (!page.length) return [...directories];
        for (const directory of runningDirectories(this.#db, since, page)) {
          directories.add(directory);
        }
        after = page.at(-1)!;
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
    } catch (error) {
      signal.throwIfAborted();
      this.diagnostic(
        "warn",
        "harness db: activity authority unavailable",
        error,
      );
      return;
    }
  }
  /** Undefined = unavailable; null = no following native message. */
  nextMessageID(id: string, through: string): string | null | undefined {
    id = ids.decode(id);
    if (!this.#db) return;
    try {
      const row = this.#db.prepare(
        "SELECT id FROM message WHERE session_id = ? AND id > ? ORDER BY id LIMIT 1",
      ).get(id, through);
      return row ? String(row.id) : null;
    } catch {
      return;
    }
  }
  /** One scalar result, never message/part JSON or transcript content. */
  revertedUserCount(id: string, cutoff: string): number | undefined {
    id = ids.decode(id);
    if (!this.#db) return;
    return Number(
      this.#db.prepare(`
      SELECT count(*) AS count FROM message
      WHERE session_id = ? AND id >= ? AND json_extract(data, '$.role') = 'user'
    `).get(id, cutoff)!.count,
    );
  }
  /** First non-synthetic text or attachment labels, oldest first, bounded rows. */
  revertedPrompts(
    id: string,
    cutoff: string,
    limit: number,
  ): { messageID: string; time: number; text: string }[] | undefined {
    id = ids.decode(id);
    if (!this.#db) return;
    try {
      return this.#db.prepare(
        `SELECT m.id, json_extract(m.data,'$.time.created') AS time,
        coalesce((SELECT json_extract(p.data,'$.text') FROM part p WHERE p.message_id=m.id AND json_extract(p.data,'$.type')='text' AND coalesce(json_extract(p.data,'$.synthetic'),0)=0 ORDER BY p.id LIMIT 1),
          (SELECT group_concat(json_extract(p.data,'$.filename'), ', ') FROM part p WHERE p.message_id=m.id AND json_extract(p.data,'$.type')='file'),
          (SELECT 'Compacted conversation' FROM part p WHERE p.message_id=m.id AND json_extract(p.data,'$.type')='compaction' LIMIT 1), '') AS text
        FROM message m WHERE m.session_id=? AND m.id>=? AND json_extract(m.data,'$.role')='user' ORDER BY m.id LIMIT ?`,
      ).all(id, cutoff, limit).map((row) => ({
        messageID: String(row.id),
        time: Number(row.time),
        text: String(row.text),
      }));
    } catch {
      return;
    }
  }
  /** Bounded, metadata-only projections; never hydrate child text/tool output. */
  taskMessages(id: string): Iterable<NativeMessage> | undefined {
    id = ids.decode(id);
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
  usageMessages(
    id: string,
    turnID: string,
    signal?: AbortSignal,
  ): Iterable<UsageMessage> | undefined {
    id = ids.decode(id);
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
        AND coalesce(json_extract(data, '$.parentID'),id) = ?
        AND json_extract(data, '$.role') = 'assistant' ORDER BY id LIMIT 100`);
      const tools = this.#db.prepare(`SELECT p.id,p.message_id,
        json_extract(p.data, '$.tool') AS name,
        json_extract(p.data, '$.state.title') AS summary
        FROM part p JOIN json_each(?) wanted ON wanted.value=p.message_id
        WHERE p.session_id = ? AND p.id > ?
        AND json_extract(p.data, '$.type') = 'tool' ORDER BY p.id LIMIT 100`);
      return (function* () {
        let after = "";
        while (true) {
          signal?.throwIfAborted();
          const rows = query.all(id, after, turnID);
          if (!rows.length) break;
          const labels = new Map<string, NonNullable<UsageMessage["tools"]>>();
          let partAfter = "";
          for (;;) {
            signal?.throwIfAborted();
            const parts = tools.all(
              JSON.stringify(rows.map((row) => row.id)),
              id,
              partAfter,
            );
            if (!parts.length) break;
            for (const part of parts) {
              const key = String(part.message_id);
              let items = labels.get(key);
              if (!items) labels.set(key, items = []);
              items.push({
                id: String(part.id),
                name: String(part.name),
                ...(part.summary == null
                  ? {}
                  : { summary: String(part.summary) }),
              });
            }
            partAfter = String(parts.at(-1)!.id);
          }
          for (const row of rows) {
            yield {
              id: String(row.id),
              turnID: row.parent == null ? String(row.id) : String(row.parent),
              model: {
                provider: String(row.provider),
                model: String(row.model),
              },
              tokens: reportedTokens(
                row.tokens == null ? undefined : JSON.parse(String(row.tokens)),
              ),
              cost: reportedNumber(row.cost, false),
              completed: row.completed != null,
              time: {
                start: Number(row.created),
                ...(row.completed == null
                  ? {}
                  : { end: Number(row.completed) }),
              },
              tools: labels.get(String(row.id)) ?? [],
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
