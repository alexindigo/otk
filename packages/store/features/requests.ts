// SPDX-License-Identifier: LGPL-3.0-only
import type { OtkDb, StoreWrite } from "../db.ts";
import type { FeatureMigrations } from "../migrations.ts";
import { key } from "./metadata.ts";

export const requestsMigrations: FeatureMigrations = {
  feature: "requests",
  migrations: [{
    version: 1,
    sql: new URL("./migrations/requests/001.sql", import.meta.url),
  }],
};
export interface ReceiptKey {
  principal: string;
  client_id: string;
  intent_key: string;
}
export interface RequestRecord extends ReceiptKey {
  window_id: string;
  method: string;
  fingerprint: string;
  execution: "read" | "local" | "native" | "lease";
  state:
    | "queued"
    | "running"
    | "waiting"
    | "reconciling"
    | "succeeded"
    | "failed"
    | "released";
  seq: number;
  accepted_at: number;
  updated_at: number;
  retention_until: number;
  dispatched_at: number | null;
  owner_run: string | null;
  scope_session: string | null;
  scope_directory: string | null;
  scope_resource: string | null;
  progress_code: string | null;
  progress_completed: number | null;
  progress_total: number | null;
  receipt_kind: string | null;
  receipt_json: string | null;
  error_code: string | null;
  error_retry: "same-intent" | "new-intent" | "none" | null;
  error_field: string | null;
  diagnostic_id: string | null;
}
const identity = ["principal", "client_id", "intent_key"] as const;
const admission = [
  ...identity,
  "window_id",
  "method",
  "fingerprint",
  "execution",
  "accepted_at",
  "retention_until",
] as const;
const mutable = [
  "state",
  "seq",
  "updated_at",
  "dispatched_at",
  "owner_run",
  "scope_session",
  "scope_directory",
  "scope_resource",
  "progress_code",
  "progress_completed",
  "progress_total",
  "receipt_kind",
  "receipt_json",
  "error_code",
  "error_retry",
  "error_field",
  "diagnostic_id",
] as const;
const columns = [...admission, ...mutable];
const predicate = "principal=? AND client_id=? AND intent_key=?";
const active = "state IN ('queued','running','waiting','reconciling')";
const nullableText = [
  "owner_run",
  "scope_session",
  "scope_directory",
  "scope_resource",
  "progress_code",
  "receipt_kind",
  "error_code",
  "error_retry",
  "error_field",
  "diagnostic_id",
] as const;
function keys(value: ReceiptKey): string[] {
  return identity.map((name) => key(value[name]));
}
function integer(value: number, minimum = 0): void {
  if (!Number.isSafeInteger(value) || value < minimum) {
    throw new TypeError("Invalid request counter");
  }
}
function validate(record: RequestRecord): void {
  for (const name of Object.keys(record)) {
    if (!columns.includes(name as typeof columns[number])) {
      throw new TypeError("Unknown receipt field");
    }
  }
  for (const name of columns) {
    const value = record[name];
    if (value === undefined) throw new TypeError("Missing receipt field");
    if (typeof value === "number") integer(value);
    else if (value !== null && typeof value !== "string") {
      throw new TypeError("Invalid receipt scalar");
    }
  }
  keys(record);
  for (const name of nullableText) {
    if (record[name] !== null) key(record[name]);
  }
  if (record.receipt_json !== null && typeof record.receipt_json !== "string") {
    throw new TypeError("Invalid receipt JSON");
  }
  for (const name of ["window_id", "method"] as const) key(record[name]);
  if (!/^[a-f0-9]{64}$/.test(record.fingerprint)) {
    throw new TypeError("Invalid request fingerprint");
  }
  if (!["read", "local", "native", "lease"].includes(record.execution)) {
    throw new TypeError("Invalid request execution");
  }
  if (
    ![
      "queued",
      "running",
      "waiting",
      "reconciling",
      "succeeded",
      "failed",
      "released",
    ].includes(record.state)
  ) throw new TypeError("Invalid request state");
  integer(record.seq, 1);
  for (
    const name of ["accepted_at", "updated_at", "retention_until"] as const
  ) integer(record[name]);
  for (
    const name of [
      "dispatched_at",
      "progress_completed",
      "progress_total",
    ] as const
  ) {
    if (record[name] !== null) integer(record[name]);
  }
  if (
    record.updated_at < record.accepted_at ||
    record.retention_until < record.accepted_at
  ) throw new TypeError("Invalid receipt clocks");
  if (
    record.error_retry !== null &&
    !["same-intent", "new-intent", "none"].includes(record.error_retry)
  ) throw new TypeError("Invalid request retry");
  if ((record.receipt_kind === null) !== (record.receipt_json === null)) {
    throw new TypeError("Incomplete receipt");
  }
  if (record.receipt_json !== null) JSON.parse(record.receipt_json);
}

/** Metadata-only duplicate fences. Feature encoders own safe receipt JSON shapes. */
export class Requests {
  constructor(readonly db: OtkDb) {}
  get(input: ReceiptKey): RequestRecord | undefined {
    return this.db.connection.prepare(
      `SELECT ${columns.join(",")} FROM request_receipts WHERE ${predicate}`,
    ).get(...keys(input)) as RequestRecord | undefined;
  }
  admit(
    input: RequestRecord,
    tx?: StoreWrite,
  ): { inserted: boolean; record: RequestRecord } {
    return this.db.write(() => {
      validate(input);
      if (
        input.state !== "queued" || input.seq !== 1 ||
        input.dispatched_at !== null || input.receipt_json !== null ||
        input.error_code !== null
      ) throw new Error("Invalid request admission state");
      // Conditional insertion leaves no partial admission even when a caller
      // catches a rejection inside a larger explicitly joined write scope.
      const inserted = this.db.connection.prepare(
        `INSERT INTO request_receipts (${columns.join(",")}) SELECT ${
          columns.map(() => "?").join(",")
        } FROM request_windows WHERE id=? AND created_at<=? AND expires_at>? AND expires_at<=?
        ON CONFLICT(principal,client_id,intent_key) DO NOTHING`,
      ).run(
        ...columns.map((name) => input[name]),
        input.window_id,
        input.accepted_at,
        input.accepted_at,
        input.retention_until,
      ).changes === 1;
      // Duplicate retries compare intent facts, not caller-supplied admission clocks.
      const existing = this.get(input);
      if (!inserted && existing) {
        for (
          const name of [
            "window_id",
            "method",
            "fingerprint",
            "execution",
          ] as const
        ) {
          if (existing[name] !== input[name]) {
            throw new Error("Request intent conflict");
          }
        }
        return { inserted: false, record: existing };
      }
      if (!inserted) {
        throw new Error(
          "Request window expired, unknown or beyond receipt retention",
        );
      }
      return { inserted: true, record: existing! };
    }, tx);
  }
  transition(
    input: ReceiptKey,
    expectedSeq: number,
    patch: Partial<RequestRecord>,
    tx?: StoreWrite,
  ): RequestRecord {
    return this.db.write(() => {
      integer(expectedSeq, 1);
      for (const name of Object.keys(patch)) {
        if (
          !mutable.includes(name as typeof mutable[number]) || name === "seq"
        ) throw new TypeError("Immutable receipt field");
      }
      const previous = this.get(input);
      if (!previous || previous.seq !== expectedSeq) {
        throw new Error("Request sequence conflict");
      }
      if (
        !["queued", "running", "waiting", "reconciling"].includes(
          previous.state,
        )
      ) throw new Error("Request already settled");
      const next = { ...previous, ...patch, seq: expectedSeq + 1 };
      validate(next);
      if (
        next.updated_at < previous.updated_at ||
        (previous.dispatched_at !== null &&
          next.dispatched_at !== previous.dispatched_at)
      ) throw new Error("Request transition regressed");
      const result = this.db.connection.prepare(
        `UPDATE request_receipts SET ${
          mutable.map((name) => `${name}=?`).join(",")
        } WHERE ${predicate} AND seq=?`,
      ).run(...mutable.map((name) => next[name]), ...keys(input), expectedSeq);
      if (result.changes !== 1) throw new Error("Request sequence conflict");
      return this.get(input)!;
    }, tx);
  }
  inFlight(after: ReceiptKey | undefined, limit: number): RequestRecord[] {
    integer(limit, 1);
    return this.db.connection.prepare(
      `SELECT ${columns.join(",")} FROM request_receipts WHERE ${active}${
        after ? " AND (principal,client_id,intent_key)>(?,?,?)" : ""
      } ORDER BY principal,client_id,intent_key LIMIT ?`,
    ).all(...(after ? keys(after) : []), limit) as unknown as RequestRecord[];
  }
  sweep(now: number, limit: number): number {
    integer(now);
    integer(limit, 1);
    return this.db.write(() => {
      const result = this.db.connection.prepare(
        "DELETE FROM request_receipts WHERE rowid IN (SELECT rowid FROM request_receipts WHERE state IN ('succeeded','failed','released') AND retention_until<=? ORDER BY retention_until LIMIT ?)",
      ).run(now, limit);
      this.db.connection.prepare(
        "DELETE FROM request_windows WHERE id IN (SELECT id FROM request_windows w WHERE expires_at<=? AND NOT EXISTS (SELECT 1 FROM request_receipts r WHERE r.window_id=w.id) ORDER BY expires_at LIMIT ?)",
      ).run(now, limit);
      return Number(result.changes);
    });
  }
  window(now: number, durationMs: number): { id: string; expires_at: number } {
    integer(now);
    integer(durationMs, 1);
    integer(now + durationMs);
    return this.db.write(() => {
      const value = { id: crypto.randomUUID(), expires_at: now + durationMs };
      this.db.connection.prepare("INSERT INTO request_windows VALUES(?,?,?)")
        .run(value.id, now, value.expires_at);
      return value;
    });
  }
}
