// SPDX-License-Identifier: LGPL-3.0-only
import { DatabaseSync } from "node:sqlite";
import { fromFileUrl } from "@std/path";
import { type HistoryEntry, sameHistory } from "@otk/protocol";
import type { PromptPart } from "@otk/protocol";
interface StoredPart {
  type: string;
  text?: string;
  synthetic?: boolean;
  name?: string;
  filename?: string;
  mime?: string;
  url?: string;
  source?: {
    type?: string;
    clientName?: string;
    uri?: string;
    path?: string;
    text?: { value?: string };
  };
  state?: { input?: { command?: string } };
}
function map(
  part: StoredPart,
  messageID: string,
  partID: string,
  size?: number,
): PromptPart | undefined {
  if (part.type === "text" && !part.synthetic) {
    return { kind: "text", text: part.text || "" };
  }
  if (part.type === "agent" && part.name) {
    return { kind: "agent", name: part.name };
  }
  if (part.type !== "file") return;
  if (size !== undefined) {
    return {
      kind: "file",
      source: "history",
      name: part.filename || "attachment",
      mime: part.mime || "application/octet-stream",
      size,
      messageID,
      partID,
    };
  }
  if (!part.url) return;
  if (
    part.source?.type === "resource" && part.source.clientName &&
    part.source.uri
  ) {
    return {
      kind: "file",
      source: "resource",
      name: part.filename || "resource",
      mime: part.mime || "text/plain",
      server: part.source.clientName,
      uri: part.source.uri,
      label: part.source.text?.value || `@${part.filename || "resource"}`,
    };
  }
  const url = new URL(part.url);
  if (url.protocol === "file:") {
    const start = Number(url.searchParams.get("start")),
      end = url.searchParams.has("end")
        ? Number(url.searchParams.get("end"))
        : undefined;
    return {
      kind: "file",
      source: "path",
      path: part.source?.path || fromFileUrl(url),
      label: part.source?.text?.value ||
        `@${part.filename || fromFileUrl(url)}`,
      ...(Number.isInteger(start) && start > 0 &&
          (end === undefined || (Number.isInteger(end) && end >= start))
        ? { range: { start, ...(end === undefined ? {} : { end }) } }
        : {}),
    };
  }
}
/** Read-only OTK projection, never creates/writes the harness DB or stores history. */
export class History {
  #db: DatabaseSync | null = null;
  #error = "";
  #malformed = new Set<string>();
  constructor(readonly file: string) {}
  #open(): DatabaseSync {
    if (this.#db) return this.#db;
    const db = this.#db = new DatabaseSync(this.file, { readOnly: true });
    const required = {
      message: ["id", "session_id", "time_created", "data"],
      part: ["id", "message_id", "data"],
    };
    for (const [table, names] of Object.entries(required)) {
      const columns = new Set(
          db.prepare(`PRAGMA table_info(${table})`).all().map((row) =>
            row.name
          ),
        ),
        missing = names.filter((name) => !columns.has(name));
      if (missing.length) {
        throw new Error(`${table}: missing ${missing.join(", ")}`);
      }
    }
    return db;
  }
  list(): HistoryEntry[] {
    try {
      const db = this.#open(), result: HistoryEntry[] = [];
      const rows = db.prepare(
        "SELECT id,session_id,time_created FROM message WHERE CASE WHEN json_valid(data) THEN json_extract(data,'$.role')='user' ELSE 0 END ORDER BY time_created DESC,id DESC LIMIT 50",
      ).all();
      const parts = db.prepare(
          `SELECT id,
            CASE WHEN json_valid(data) THEN CASE WHEN json_extract(data,'$.url') LIKE 'data:%;base64,%'
              THEN json_set(json_remove(data,'$.url'),'$.mime',coalesce(json_extract(data,'$.mime'),substr(json_extract(data,'$.url'),6,instr(json_extract(data,'$.url'),';')-6))) ELSE data END ELSE data END AS data,
            CASE WHEN json_valid(data) THEN CASE WHEN json_extract(data,'$.url') LIKE 'data:%;base64,%'
              THEN (length(json_extract(data,'$.url'))-instr(json_extract(data,'$.url'),','))/4*3 - CASE WHEN substr(json_extract(data,'$.url'),-2)='==' THEN 2 WHEN substr(json_extract(data,'$.url'),-1)='=' THEN 1 ELSE 0 END END END AS size
            FROM part WHERE message_id=? ORDER BY id`,
        ),
        shell = db.prepare(
          "SELECT p.data FROM message a JOIN part p ON p.message_id=a.id WHERE a.session_id=? AND a.time_created>=? AND a.time_created<? AND CASE WHEN json_valid(a.data) THEN json_extract(a.data,'$.role')='assistant' AND json_extract(a.data,'$.parentID')=? ELSE 0 END AND CASE WHEN json_valid(p.data) THEN json_extract(p.data,'$.type')='tool' AND json_extract(p.data,'$.tool')='bash' ELSE 0 END ORDER BY a.time_created,a.id,p.id LIMIT 1",
        );
      const nextUser = db.prepare(
        "SELECT time_created FROM message WHERE session_id=? AND time_created>? AND CASE WHEN json_valid(data) THEN json_extract(data,'$.role')='user' ELSE 0 END ORDER BY time_created LIMIT 1",
      );
      for (const row of rows) {
        try {
          const stored = parts.all(String(row.id));
          const raw = stored.map((part) =>
              JSON.parse(String(part.data)) as StoredPart
            ),
            mapped = raw.map((part, i) =>
              map(
                part,
                String(row.id),
                String(stored[i].id),
                typeof stored[i].size === "number" ? stored[i].size : undefined,
              )
            ).filter((part): part is PromptPart => !!part);
          let input = mapped.filter((part) => part.kind === "text").map((
              part,
            ) => part.text
            ).join("\n"),
            mode: HistoryEntry["mode"] = "normal",
            promptParts = mapped;
          if (
            raw.some((part) =>
              part.type === "text" && part.synthetic &&
              part.text === "The following tool was executed by the user"
            ) && !mapped.length
          ) {
            const bound = Number(
              nextUser.get(String(row.session_id), Number(row.time_created))
                ?.time_created ?? Number.MAX_SAFE_INTEGER,
            );
            const tool = shell.get(
                String(row.session_id),
                Number(row.time_created),
                bound,
                String(row.id),
              ),
              command = tool
                ? (JSON.parse(String(tool.data)) as StoredPart).state?.input
                  ?.command
                : undefined;
            if (typeof command !== "string") continue;
            input = command;
            mode = "shell";
            promptParts = [{ kind: "text", text: command }];
          }
          if (!input.trim() && !promptParts.length) continue;
          const entry = {
            input,
            mode,
            parts: promptParts,
            time: Number(row.time_created),
          };
          if (!sameHistory(result.at(-1), entry)) result.push(entry);
        } catch (error) {
          const id = String(row.id);
          if (!this.#malformed.has(id)) {
            console.warn(
              `history db: skipped malformed message ${id}: ${
                (error as Error).message
              }`,
            );
            this.#malformed.add(id);
          }
        }
      }
      this.#error = "";
      return result;
    } catch (error) {
      this.close();
      const message = (error as Error).message;
      if (message !== this.#error) {
        console.warn(`history db: degraded (empty history): ${message}`);
      }
      this.#error = message;
      return [];
    }
  }
  attachment(
    messageID: string,
    partID: string,
  ): Extract<PromptPart, { source: "upload" }> {
    const row = this.#open().prepare(
      "SELECT p.data FROM part p JOIN message m ON m.id=p.message_id WHERE p.message_id=? AND p.id=? AND CASE WHEN json_valid(m.data) THEN json_extract(m.data,'$.role')='user' ELSE 0 END",
    ).get(messageID, partID);
    if (!row) throw new Error("Recalled attachment is no longer available");
    const part = JSON.parse(String(row.data)) as StoredPart;
    const data = typeof part.url === "string" &&
      /^data:([^;]*);base64,([\s\S]*)$/.exec(part.url);
    if (part.type !== "file" || !data) {
      throw new Error("Recalled attachment has no stored upload bytes");
    }
    return {
      kind: "file",
      source: "upload",
      name: part.filename || "attachment",
      mime: part.mime || data[1],
      dataBase64: data[2],
    };
  }
  close() {
    this.#db?.close();
    this.#db = null;
  }
}
