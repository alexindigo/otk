// SPDX-License-Identifier: LGPL-3.0-only
import { errorMessage } from "@otk/protocol";
import { DatabaseSync } from "node:sqlite";
import { fromFileUrl } from "@std/path";
import { type HistoryEntry, sameHistory } from "@otk/protocol";
import type { PromptPart } from "@otk/protocol";
import type { HistoryAttachmentRef, HistoryCapability } from "@otk/harness";
export interface StoredPart {
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
    path?: string | null;
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
/** Shared SQL/API mapping; inline upload bytes never enter a history entry. */
export function historyEntry(
  messageID: string,
  time: number,
  parts: (StoredPart & { id: string; size?: number })[],
  command?: string,
): HistoryEntry | undefined {
  const mapped = parts.map((part) => {
    const data = part.url?.match(/^data:([^;]*);base64,([\s\S]*)$/);
    const size = part.size ??
      (data
        ? data[2].length / 4 * 3 -
          (data[2].endsWith("==") ? 2 : data[2].endsWith("=") ? 1 : 0)
        : undefined);
    return map(part, messageID, part.id, size);
  }).filter((part): part is PromptPart => !!part);
  if (command !== undefined) {
    return {
      input: command,
      mode: "shell",
      parts: [{ kind: "text", text: command }],
      time,
    };
  }
  const input = mapped.filter((part) => part.kind === "text").map((part) =>
    part.text
  ).join("\n");
  if (!input.trim() && !mapped.length) return;
  return { input, mode: "normal", parts: mapped, time };
}
/** Read-only OTK projection, never creates/writes the harness DB or stores history. */
export class History implements HistoryCapability {
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
  listHistory(): Promise<HistoryEntry[]> {
    return new Promise((resolve) => resolve(this.#list()));
  }
  entry(sessionID: string, messageID: string): HistoryEntry | undefined {
    try {
      const row = this.#open().prepare(
        "SELECT id,session_id,time_created FROM message WHERE session_id=? AND id=? AND json_extract(data,'$.role')='user'",
      ).get(sessionID, messageID);
      return row ? this.#entry(row) : undefined;
    } catch {
      return;
    }
  }
  #list(): HistoryEntry[] {
    try {
      const db = this.#open(), result: HistoryEntry[] = [];
      const rows = db.prepare(
        "SELECT id,session_id,time_created FROM message WHERE CASE WHEN json_valid(data) THEN json_extract(data,'$.role')='user' ELSE 0 END ORDER BY time_created DESC,id DESC LIMIT 50",
      ).all();
      for (const row of rows) {
        const entry = this.#entry(row);
        if (entry && !sameHistory(result.at(-1), entry)) result.push(entry);
      }
      this.#error = "";
      return result;
    } catch (error) {
      this.close();
      const message = errorMessage(error);
      if (message !== this.#error) {
        console.warn(`history db: degraded (empty history): ${message}`);
      }
      this.#error = message;
      return [];
    }
  }
  #entry(row: Record<string, unknown>): HistoryEntry | undefined {
    const db = this.#open();
    try {
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
      const stored = parts.all(String(row.id));
      const raw = stored.map((part) => ({
        ...JSON.parse(String(part.data)) as StoredPart,
        id: String(part.id),
        size: typeof part.size === "number" ? part.size : undefined,
      }));
      const mapped = historyEntry(
        String(row.id),
        Number(row.time_created),
        raw,
      );
      if (
        raw.some((part) =>
          part.type === "text" && part.synthetic &&
          part.text === "The following tool was executed by the user"
        ) && !mapped
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
        if (typeof command !== "string") return;
        return historyEntry(
          String(row.id),
          Number(row.time_created),
          raw,
          command,
        );
      }
      return mapped;
    } catch (error) {
      const id = String(row.id);
      if (!this.#malformed.has(id)) {
        console.warn(
          `history db: skipped malformed message ${id}: ${errorMessage(error)}`,
        );
        this.#malformed.add(id);
      }
    }
  }
  attachment(
    ref: HistoryAttachmentRef,
  ): Promise<Extract<PromptPart, { source: "upload" }>> {
    return new Promise((resolve) => resolve(this.#attachment(ref)));
  }
  #attachment(
    { messageID, partID }: HistoryAttachmentRef,
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
