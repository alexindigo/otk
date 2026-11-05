// SPDX-License-Identifier: LGPL-3.0-only
import { DatabaseSync } from "node:sqlite";
import {
  type AttachmentPolicy,
  type DiagnosticSink,
  type HistoryAttachmentRef,
  type HistoryEntry,
  MAX_UPLOAD_BYTES,
  PROMPT_HISTORY_LIMIT,
  sameHistory,
  uploadSize,
} from "@otk/protocol";
import type {
  HistoryAttachment,
  HistoryCapability,
  ProviderReaders,
  ProviderReadOptions,
  ProviderReadPort,
} from "@otk/harness";
import { historyEntry, type StoredPart } from "./history-mapping.ts";
import { opencodeV1SessionID as ids } from "./ids.ts";
import { NativeRequestFailure } from "./client.ts";
export { historyEntry } from "./history-mapping.ts";
export type { StoredPart } from "./history-mapping.ts";

const SCAN_ROWS = 100;
type Row = Record<string, unknown>;
const validRole =
  "CASE WHEN json_valid(data) THEN json_extract(data,'$.role') END";
const upload = "json_extract(p.data,'$.url')";
const bytes =
  `(length(${upload})-instr(${upload},','))/4*3 - CASE WHEN substr(${upload},-2)='==' THEN 2 WHEN substr(${upload},-1)='=' THEN 1 ELSE 0 END`;
function attachmentFailure(
  message: string,
  code = "attachment.invalid",
): NativeRequestFailure {
  return new NativeRequestFailure("rejected", new Error(message), code);
}
/** Worker-local native reader. The selected sink supplies its existing SQLite owner. */
export class HistoryReader {
  #malformed = new Set<string>();
  constructor(
    readonly database: () => Pick<DatabaseSync, "prepare">,
    readonly policy: Pick<AttachmentPolicy, "maxrefs" | "maxbytes">,
    readonly yieldTurn: () => Promise<void> = () =>
      new Promise((resolve) => setTimeout(resolve, 0)),
    readonly diagnostic: DiagnosticSink = () => {},
  ) {}
  async list(signal?: AbortSignal): Promise<HistoryEntry[]> {
    const selected: Row[] = [];
    let cursor: Row | undefined;
    while (selected.length < PROMPT_HISTORY_LIMIT) {
      signal?.throwIfAborted();
      const rows = this.database().prepare(
        `SELECT id,session_id,time_created,${validRole} AS role FROM message ${
          cursor ? "WHERE (time_created,id)<(?,?)" : ""
        } ORDER BY time_created DESC,id DESC LIMIT ?`,
      ).all(
        ...(cursor
          ? [Number(cursor.time_created), String(cursor.id), SCAN_ROWS]
          : [SCAN_ROWS]),
      );
      for (const row of rows) {
        if (row.role === "user") selected.push(row);
        if (selected.length === PROMPT_HISTORY_LIMIT) break;
      }
      if (rows.length < SCAN_ROWS || selected.length === PROMPT_HISTORY_LIMIT) {
        break;
      }
      cursor = rows.at(-1);
      await this.yieldTurn();
    }
    signal?.throwIfAborted();
    const entries = this.#entries(selected), result: HistoryEntry[] = [];
    for (const entry of entries) {
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
    const rows = this.database().prepare(
      `SELECT m.id,m.session_id,m.time_created FROM message m JOIN json_each(?) wanted ON m.id=json_extract(wanted.value,'$.messageID') AND m.session_id=json_extract(wanted.value,'$.sessionID') WHERE CASE WHEN json_valid(m.data) THEN json_extract(m.data,'$.role')='user' ELSE 0 END ORDER BY wanted.key`,
    ).all(
      JSON.stringify(
        keys.map((key) => ({ ...key, sessionID: ids.decode(key.sessionID) })),
      ),
    );
    return this.#entries(rows);
  }
  #entries(rows: Row[]): HistoryEntry[] {
    if (!rows.length) return [];
    const db = this.database(), input = JSON.stringify(rows);
    const stored = db.prepare(`SELECT p.message_id,p.id,
      CASE WHEN json_valid(p.data) AND ${upload} LIKE 'data:%;base64,%' THEN json_set(json_remove(p.data,'$.url'),'$.mime',coalesce(json_extract(p.data,'$.mime'),substr(${upload},6,instr(${upload},';')-6))) ELSE p.data END AS data,
      CASE WHEN json_valid(p.data) AND ${upload} LIKE 'data:%;base64,%' THEN ${bytes} END AS size
      FROM part p JOIN json_each(?) wanted ON p.message_id=json_extract(wanted.value,'$.id') ORDER BY p.message_id,p.id`)
      .all(input);
    // Distinct user clocks preserve the old strict next-user boundary, including ties.
    const commands = db.prepare(
      `WITH selected AS (SELECT json_extract(value,'$.id') AS id,json_extract(value,'$.session_id') AS session_id,json_extract(value,'$.time_created') AS time_created FROM json_each(?)),
      clocks AS (SELECT session_id,time_created,lead(time_created) OVER (PARTITION BY session_id ORDER BY time_created) AS next FROM message WHERE session_id IN (SELECT session_id FROM selected) AND ${validRole}='user' GROUP BY session_id,time_created),
      candidates AS (SELECT s.id,json_extract(p.data,'$.state.input.command') AS command,row_number() OVER (PARTITION BY s.id ORDER BY a.time_created,a.id,p.id) AS position FROM selected s JOIN clocks c ON c.session_id=s.session_id AND c.time_created=s.time_created CROSS JOIN message a ON a.session_id=s.session_id AND a.time_created>=s.time_created AND a.time_created<coalesce(c.next,9007199254740991) JOIN part p ON p.message_id=a.id WHERE CASE WHEN json_valid(a.data) THEN json_extract(a.data,'$.role')='assistant' AND json_extract(a.data,'$.parentID')=s.id ELSE 0 END AND CASE WHEN json_valid(p.data) THEN json_extract(p.data,'$.type')='tool' AND json_extract(p.data,'$.tool')='bash' ELSE 0 END)
      SELECT id,command FROM candidates WHERE position=1`,
    ).all(input);
    const parts = new Map<string, Row[]>(),
      shells = new Map(commands.map((row) => [String(row.id), row.command]));
    for (const part of stored) {
      const key = String(part.message_id), values = parts.get(key) ?? [];
      values.push(part);
      parts.set(key, values);
    }
    const result: HistoryEntry[] = [];
    for (const row of rows) {
      try {
        const raw = (parts.get(String(row.id)) ?? []).map((part) => ({
          ...JSON.parse(String(part.data)) as StoredPart,
          id: String(part.id),
          size: typeof part.size === "number" ? part.size : undefined,
        }));
        let entry = historyEntry(String(row.id), Number(row.time_created), raw);
        if (
          !entry && raw.some((p) =>
            p.type === "text" && p.synthetic &&
            p.text === "The following tool was executed by the user"
          )
        ) {
          const command = shells.get(String(row.id));
          if (typeof command === "string") {
            entry = historyEntry(
              String(row.id),
              Number(row.time_created),
              raw,
              command,
            );
          }
        }
        if (entry) result.push(entry);
      } catch (error) {
        if (!this.#malformed.has(String(row.id))) {
          this.#malformed.add(String(row.id));
          this.diagnostic(
            "warn",
            `history db: skipped malformed message ${row.id}`,
            error,
          );
        }
      }
    }
    return result;
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
          .size !== refs.length
    ) throw attachmentFailure("Invalid recalled attachment batch");
    const db = this.database(), input = JSON.stringify(refs);
    // First query returns only scalar admission facts, never selected upload bodies.
    const facts = db.prepare(
      `SELECT wanted.key AS position, json_extract(p.data,'$.type') AS type, substr(${upload},1,5) AS scheme, instr(${upload},';base64,') AS encoding, ${bytes} AS size FROM json_each(?) wanted JOIN part p ON p.message_id=json_extract(wanted.value,'$.messageID') AND p.id=json_extract(wanted.value,'$.partID') JOIN message m ON m.id=p.message_id WHERE CASE WHEN json_valid(m.data) THEN json_extract(m.data,'$.role')='user' ELSE 0 END AND json_valid(p.data) ORDER BY wanted.key`,
    ).all(input);
    if (facts.length !== refs.length) {
      throw attachmentFailure(
        "Recalled attachment is no longer available",
        "attachment.unreadable",
      );
    }
    let total = 0;
    for (const fact of facts) {
      if (
        fact.type !== "file" || fact.scheme !== "data:" ||
        Number(fact.encoding) < 6
      ) {
        throw attachmentFailure(
          "Recalled attachment has no stored upload bytes",
        );
      }
      const size = Number(fact.size);
      if (
        !Number.isSafeInteger(size) || size < 0 || size > MAX_UPLOAD_BYTES ||
        (total += size) > this.policy.maxbytes
      ) {
        throw attachmentFailure(
          "Recalled attachments exceed the upload byte limit",
        );
      }
    }
    signal?.throwIfAborted();
    const bodies = db.prepare(
      `SELECT p.data FROM json_each(?) wanted JOIN part p ON p.message_id=json_extract(wanted.value,'$.messageID') AND p.id=json_extract(wanted.value,'$.partID') ORDER BY wanted.key`,
    ).all(input);
    if (bodies.length !== refs.length) {
      throw attachmentFailure("Recalled attachment changed during preparation");
    }
    return bodies.map((row, i) => {
      const part = JSON.parse(String(row.data)) as StoredPart;
      const data = part.url?.match(
        /^data:([^;]*);base64,([A-Za-z0-9+/]*={0,2})$/,
      );
      if (
        part.type !== "file" || !data || data[2].length % 4 ||
        uploadSize(data[2]) !== Number(facts[i].size)
      ) throw attachmentFailure("Invalid recalled attachment bytes");
      return {
        ref: { messageID: refs[i].messageID, partID: refs[i].partID },
        part: {
          kind: "file",
          source: "upload",
          name: part.filename || "attachment",
          mime: part.mime || data[1] || "application/octet-stream",
          dataBase64: data[2],
        },
      };
    });
  }
  readers(): ProviderReaders {
    return {
      "history.list": (_input, signal) => this.list(signal),
      "history.entries": (input, signal) =>
        Promise.resolve(this.entries(input.keys, signal)),
      "history.attachments": (input, signal) =>
        Promise.resolve(this.attachments(input.refs, signal)),
    };
  }
}

/** One read-only connection per standalone owner, invalidated by provider file identity. */
export class HistoryDatabase {
  #db?: DatabaseSync;
  #identity?: string;
  constructor(readonly file: string) {}
  reader(
    policy: Pick<AttachmentPolicy, "maxrefs" | "maxbytes">,
    yieldTurn?: () => Promise<void>,
    diagnostic?: DiagnosticSink,
  ): HistoryReader {
    return new HistoryReader(
      () => {
        const stat = Deno.statSync(this.file);
        const identity = `${stat.dev}:${stat.ino}:${stat.birthtime?.getTime()}`;
        if (this.#db && identity !== this.#identity) this.close();
        if (!this.#db) {
          this.#db = new DatabaseSync(this.file, { readOnly: true });
          this.#identity = identity;
        }
        return this.#db;
      },
      policy,
      yieldTurn,
      diagnostic,
    );
  }
  close(): void {
    this.#db?.close();
    this.#db = undefined;
    this.#identity = undefined;
  }
}

/** Public facade: shipped reads use the injected worker; standalone file readers stay read-only. */
export class History implements HistoryCapability {
  #database?: HistoryDatabase;
  #reader?: HistoryReader;
  #owners = new Map<string, AbortController>();
  constructor(
    readonly source: string | ProviderReadPort,
    readonly policy: Pick<AttachmentPolicy, "maxrefs" | "maxbytes">,
    readonly diagnostic: DiagnosticSink = () => {},
  ) {}
  #local(): HistoryReader {
    if (typeof this.source !== "string") {
      throw new Error("Expected native database");
    }
    this.#database ??= new HistoryDatabase(this.source);
    return this.#reader ??= this.#database.reader(
      this.policy,
      undefined,
      this.diagnostic,
    );
  }
  async #read<
    K extends "history.list" | "history.entries" | "history.attachments",
  >(
    kind: K,
    input: import("@otk/harness").ProviderReadKinds[K]["input"],
    signal?: AbortSignal,
    priority: ProviderReadOptions["priority"] = "user",
  ): Promise<import("@otk/harness").ProviderReadKinds[K]["result"]> {
    signal?.throwIfAborted();
    const owner = JSON.stringify(["history", crypto.randomUUID()]);
    const controller = new AbortController();
    const owned = signal
      ? AbortSignal.any([signal, controller.signal])
      : controller.signal;
    this.#owners.set(owner, controller);
    try {
      if (typeof this.source === "string") {
        const reader = this.#local().readers()[kind]!;
        return await reader(input, owned);
      }
      return await this.source.read(kind, input, {
        owner,
        priority,
        signal: owned,
      });
    } finally {
      this.#owners.delete(owner);
    }
  }
  listHistory(signal?: AbortSignal): Promise<HistoryEntry[]> {
    return this.#read("history.list", {}, signal);
  }
  entries(
    keys: { sessionID: string; messageID: string }[],
    signal?: AbortSignal,
  ): Promise<HistoryEntry[]> {
    return this.#read("history.entries", { keys }, signal);
  }
  async entry(
    sessionID: string,
    messageID: string,
    signal?: AbortSignal,
    priority: ProviderReadOptions["priority"] = "user",
  ): Promise<HistoryEntry | undefined> {
    return (await this.#read(
      "history.entries",
      {
        keys: [{ sessionID, messageID }],
      },
      signal,
      priority,
    ))[0];
  }
  async attachments(
    refs: HistoryAttachmentRef[],
    signal?: AbortSignal,
  ): Promise<HistoryAttachment[]> {
    signal?.throwIfAborted();
    const items = refs.length
      ? await this.#read("history.attachments", { refs }, signal)
      : [];
    if (
      items.length !== refs.length ||
      items.some((item, i) =>
        item.ref.messageID !== refs[i].messageID ||
        item.ref.partID !== refs[i].partID
      )
    ) throw new Error("Recalled attachment identities changed");
    return items;
  }
  async attachment(
    ref: HistoryAttachmentRef,
    signal?: AbortSignal,
  ): Promise<HistoryAttachment["part"]> {
    return (await this.attachments([ref], signal))[0].part;
  }
  close(): void {
    for (const [owner, controller] of this.#owners) {
      controller.abort();
      if (typeof this.source !== "string") this.source.release(owner);
    }
    this.#owners.clear();
    this.#database?.close();
  }
}
