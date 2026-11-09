// SPDX-License-Identifier: LGPL-3.0-only
import type { DatabaseSync } from "node:sqlite";
import { encodeBase64 } from "@std/encoding/base64";
import type { HistoryAttachment, ProviderReaders } from "@otk/harness";
import {
  type AttachmentPolicy,
  type HistoryAttachmentRef,
  type HistoryEntry,
  MAX_UPLOAD_BYTES,
  OperationFailure,
  PROMPT_HISTORY_LIMIT,
  sameHistory,
  uploadSize,
} from "@otk/protocol";
import { opencodeV2SessionID as ids } from "./ids.ts";

type Row = Record<string, unknown>;
const SCAN_ROWS = 100;
const fileJson = "CASE WHEN f.type='object' THEN f.value END";
const encoded = `json_extract(${fileJson},'$.data')`;
const inlineBytes =
  `(length(${encoded})/4*3 - CASE WHEN substr(${encoded},-2)='==' THEN 2 WHEN substr(${encoded},-1)='=' THEN 1 ELSE 0 END)`;
function rejected(message: string, code = "attachment.invalid"): never {
  throw new OperationFailure("rejected", code, new Error(message));
}
/** On-intent reads borrow the selected worker's proven, read-only native owner. */
export class HistoryReader {
  constructor(
    readonly database: () => Pick<DatabaseSync, "prepare">,
    readonly policy: Pick<AttachmentPolicy, "maxrefs" | "maxbytes">,
    readonly yieldTurn: () => Promise<void> = () =>
      new Promise((resolve) => setTimeout(resolve, 0)),
  ) {}
  async list(
    signal?: AbortSignal,
    directory?: string,
  ): Promise<HistoryEntry[]> {
    const selected: Row[] = [];
    let cursor: Row | undefined;
    while (selected.length < PROMPT_HISTORY_LIMIT) {
      signal?.throwIfAborted();
      const rows = this.database().prepare(
        `SELECT m.id,m.session_id,m.time_created,m.type ${
          directory === undefined ? "" : ",s.directory"
        } FROM session_message m
        ${
          directory === undefined
            ? ""
            : "LEFT JOIN session_v2 s ON s.id=m.session_id"
        }
        WHERE 1
        ${cursor ? "AND (m.time_created,m.id)<(?,?)" : ""}
        ORDER BY m.time_created DESC,m.id DESC LIMIT ?`,
      ).all(
        ...(cursor ? [Number(cursor.time_created), String(cursor.id)] : []),
        SCAN_ROWS,
      );
      for (const row of rows) {
        if (
          (row.type === "user" || row.type === "shell") &&
          (directory === undefined || row.directory === directory)
        ) selected.push(row);
        if (selected.length === PROMPT_HISTORY_LIMIT) break;
      }
      if (rows.length < SCAN_ROWS || selected.length >= PROMPT_HISTORY_LIMIT) {
        break;
      }
      cursor = rows.at(-1);
      await this.yieldTurn();
    }
    signal?.throwIfAborted();
    const result: HistoryEntry[] = [];
    for (const entry of this.#entries(selected, signal)) {
      if (!sameHistory(result.at(-1), entry)) result.push(entry);
    }
    return result;
  }
  entries(
    keys: { sessionID: string; messageID: string }[],
    signal?: AbortSignal,
  ): HistoryEntry[] {
    signal?.throwIfAborted();
    if (!keys.length) return [];
    if (keys.length > SCAN_ROWS) {
      throw new Error("History entry batch exceeds its row budget");
    }
    const rows = this.database().prepare(
      `SELECT m.id,m.session_id,m.time_created,m.type FROM json_each(?) wanted
      JOIN session_message m ON m.id=json_extract(wanted.value,'$.messageID') AND m.session_id=json_extract(wanted.value,'$.sessionID')
      WHERE m.type IN ('user','shell') ORDER BY wanted.key`,
    ).all(
      JSON.stringify(
        keys.map((key) => ({ ...key, sessionID: ids.decode(key.sessionID) })),
      ),
    );
    return this.#entries(rows, signal);
  }
  #blobs(): boolean {
    return this.database().prepare(
      "SELECT count(*) AS n FROM sqlite_schema WHERE type='table' AND name IN ('blob','blob_ref')",
    ).get()?.n === 2;
  }
  #entries(selected: Row[], signal?: AbortSignal): HistoryEntry[] {
    if (!selected.length) return [];
    const db = this.database(), input = JSON.stringify(selected);
    const messages = db.prepare(`SELECT m.id,m.type,m.time_created,
      json_extract(m.data,'$.text') AS text,json_extract(m.data,'$.command') AS command,
      CASE WHEN json_type(m.data,'$.agents')='array' THEN json_extract(m.data,'$.agents') END AS agents
      FROM json_each(?) wanted JOIN session_message m ON m.id=json_extract(wanted.value,'$.id')
      AND m.session_id=json_extract(wanted.value,'$.session_id') WHERE json_valid(m.data) ORDER BY wanted.key`)
      .all(input);
    const blobs = this.#blobs();
    const files = db.prepare(`SELECT m.id, f.key AS ordinal,
      json_extract(${fileJson},'$.name') AS name,json_extract(${fileJson},'$.mime') AS mime,
      CASE WHEN ${encoded} IS NOT NULL THEN ${inlineBytes} ${
      blobs ? "ELSE b.bytes" : ""
    } END AS size
      FROM json_each(?) wanted JOIN session_message m ON m.id=json_extract(wanted.value,'$.id')
      AND m.session_id=json_extract(wanted.value,'$.session_id')
      JOIN json_each(CASE WHEN json_valid(m.data) THEN json_extract(m.data,'$.files') END) f
      ${
      blobs
        ? `LEFT JOIN blob_ref r ON r.session_id=m.session_id AND r.message_id=m.id AND r.hash=substr(json_extract(${fileJson},'$.uri'),7) LEFT JOIN blob b ON b.hash=r.hash`
        : ""
    }
      WHERE m.type='user' ORDER BY wanted.key,f.key`).all(input);
    signal?.throwIfAborted();
    return messages.flatMap((row): HistoryEntry[] => {
      const input = row.type === "shell" ? row.command : row.text;
      if (typeof input !== "string") return [];
      const selectedFiles = files.filter((file) => file.id === row.id);
      if (
        selectedFiles.some((file) =>
          typeof file.size !== "number" || !Number.isSafeInteger(file.size) ||
          file.size < 0 || typeof file.ordinal !== "number" ||
          !Number.isSafeInteger(file.ordinal) || file.ordinal < 0
        )
      ) return [];
      const parts: HistoryEntry["parts"] = row.type === "shell"
        ? []
        : selectedFiles.map((file) => ({
          kind: "file",
          source: "history",
          messageID: String(row.id),
          partID: `file:${file.ordinal}`,
          name: typeof file.name === "string" && file.name
            ? file.name
            : "attachment",
          mime: typeof file.mime === "string" && file.mime
            ? file.mime
            : "application/octet-stream",
          size: Number(file.size),
        }));
      if (row.type === "user" && typeof row.agents === "string") {
        const agents: unknown = JSON.parse(row.agents);
        if (Array.isArray(agents)) {
          for (const agent of agents) {
            if (
              agent && typeof agent === "object" &&
              typeof agent.name === "string"
            ) parts.push({ kind: "agent", name: agent.name });
          }
        }
      }
      return [{
        input,
        parts,
        mode: row.type === "shell" ? "shell" : "normal",
        time: Number(row.time_created),
      }];
    });
  }
  attachments(
    refs: HistoryAttachmentRef[],
    signal?: AbortSignal,
  ): HistoryAttachment[] {
    signal?.throwIfAborted();
    if (!refs.length) return [];
    if (
      refs.length > this.policy.maxrefs ||
      new Set(refs.map((ref) => JSON.stringify([ref.messageID, ref.partID])))
          .size !== refs.length ||
      refs.some((ref) => !/^file:(0|[1-9]\d*)$/.test(ref.partID))
    ) rejected("Invalid recalled attachment batch");
    const input = JSON.stringify(refs),
      db = this.database(),
      blobs = this.#blobs();
    const joins =
      `FROM json_each(?) wanted JOIN session_message m ON m.id=json_extract(wanted.value,'$.messageID')
      JOIN json_each(CASE WHEN json_valid(m.data) THEN json_extract(m.data,'$.files') END) f
      ON f.key=CAST(substr(json_extract(wanted.value,'$.partID'),6) AS INTEGER)
      ${
        blobs
          ? `LEFT JOIN blob_ref r ON r.session_id=m.session_id AND r.message_id=m.id AND r.hash=substr(json_extract(${fileJson},'$.uri'),7) LEFT JOIN blob b ON b.hash=r.hash`
          : ""
      }
      WHERE m.type='user' ORDER BY wanted.key`;
    // All scalar facts for the complete batch precede the first selected byte read.
    const facts = db.prepare(`SELECT m.session_id,m.id,wanted.key AS position,
      json_extract(${fileJson},'$.name') AS name,json_extract(${fileJson},'$.mime') AS mime,
      json_extract(${fileJson},'$.uri') AS uri,
      CASE WHEN ${encoded} IS NOT NULL THEN 'inline' ELSE 'media' END AS encoding,
      CASE WHEN ${encoded} IS NOT NULL THEN ${inlineBytes} ${
      blobs ? "ELSE b.bytes" : ""
    } END AS size,
      ${blobs ? "length(b.data)" : "NULL"} AS actualSize ${joins}`).all(input);
    if (facts.length !== refs.length) {
      rejected(
        "Recalled attachment is no longer available",
        "attachment.unreadable",
      );
    }
    let total = 0;
    for (const fact of facts) {
      const size = fact.size;
      if (
        typeof size !== "number" || !Number.isSafeInteger(size) || size < 0 ||
        size > MAX_UPLOAD_BYTES || (total += size) > this.policy.maxbytes
      ) rejected("Recalled attachments exceed the upload byte limit");
      if (
        fact.encoding === "media" &&
        (typeof fact.uri !== "string" ||
          !/^media:[a-f0-9]{64}$/.test(fact.uri) || fact.actualSize !== size)
      ) rejected("Recalled attachment has no stored upload bytes");
    }
    signal?.throwIfAborted();
    const bodies = db.prepare(
      `SELECT m.session_id,m.id,json_extract(${fileJson},'$.name') AS name,json_extract(${fileJson},'$.mime') AS mime,
      json_extract(${fileJson},'$.uri') AS uri,${encoded} AS inline,${
        blobs ? "b.data" : "NULL"
      } AS bytes ${joins}`,
    ).all(input);
    if (bodies.length !== refs.length) {
      rejected("Recalled attachment changed during preparation");
    }
    return bodies.map((body, index) => {
      const fact = facts[index];
      if (
        body.id !== fact.id || body.session_id !== fact.session_id ||
        body.uri !== fact.uri || body.name !== fact.name ||
        body.mime !== fact.mime
      ) rejected("Recalled attachment changed during preparation");
      const data = typeof body.inline === "string"
        ? body.inline
        : body.bytes instanceof Uint8Array
        ? encodeBase64(body.bytes)
        : undefined;
      if (
        data === undefined || data.length % 4 ||
        !/^[A-Za-z0-9+/]*={0,2}$/.test(data) || uploadSize(data) !== fact.size
      ) rejected("Invalid recalled attachment bytes");
      return {
        ref: refs[index],
        part: {
          kind: "file",
          source: "upload",
          name: typeof fact.name === "string" && fact.name
            ? fact.name
            : "attachment",
          mime: typeof fact.mime === "string" && fact.mime
            ? fact.mime
            : "application/octet-stream",
          dataBase64: data,
        },
      };
    });
  }
  readers(): ProviderReaders {
    return {
      "history.list": (input, signal) => this.list(signal, input.directory),
      "history.entries": (input, signal) =>
        Promise.resolve(this.entries(input.keys, signal)),
      "history.attachments": (input, signal) =>
        Promise.resolve(this.attachments(input.refs, signal)),
    };
  }
}
