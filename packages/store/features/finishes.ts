// SPDX-License-Identifier: LGPL-3.0-only
import type { OtkDb, StoreWrite } from "../db.ts";
import type { FeatureMigrations } from "../migrations.ts";
import { key, MetadataChanges } from "./metadata.ts";
export const finishesMigrations: FeatureMigrations = {
  feature: "finishes",
  migrations: [{
    version: 1,
    sql: new URL("./migrations/finishes/001.sql", import.meta.url),
  }, {
    version: 2,
    sql:
      "ALTER TABLE session_finishes ADD COLUMN terminal INTEGER NOT NULL DEFAULT 0;",
  }],
};
export interface FinishChange {
  session: string;
  time: number;
  terminal?: number;
}
export class Finishes extends MetadataChanges<FinishChange> {
  protected override changeKey(value: FinishChange): string {
    return value.session;
  }
  constructor(readonly db: OtkDb, readonly now: () => number = Date.now) {
    super(db);
  }
  time(session: string): number {
    return Number(
      this.db.connection.prepare(
        "SELECT time FROM session_finishes WHERE session=?",
      ).get(key(session))?.time ?? 0,
    );
  }
  list(): Record<string, number> {
    return Object.fromEntries(
      this.db.connection.prepare("SELECT session,time FROM session_finishes")
        .all().map((r) => [String(r.session), Number(r.time)]),
    );
  }
  record(session: string, tx?: StoreWrite): number {
    return this.db.write((scope) => {
      const row = this.db.connection.prepare(
        "INSERT INTO session_finishes(session,time) VALUES(?,?) ON CONFLICT(session) DO UPDATE SET time=MAX(time,excluded.time) RETURNING time",
      ).get(key(session), this.now())!;
      const time = Number(row.time);
      this.changed({ session, time }, scope);
      return time;
    }, tx);
  }
  /** Retain a proven provider terminal; duplicate/reordered observations are no-ops. */
  observe(session: string, terminal: number, tx?: StoreWrite): number {
    if (!Number.isSafeInteger(terminal) || terminal <= 0) {
      throw new TypeError("Invalid terminal token");
    }
    return this.db.write((scope) => {
      const row = this.db.connection.prepare(
        "INSERT INTO session_finishes(session,time,terminal) VALUES(?,0,?) ON CONFLICT(session) DO UPDATE SET terminal=excluded.terminal WHERE terminal<excluded.terminal RETURNING terminal",
      ).get(key(session), terminal);
      if (row) {
        this.changed({
          session,
          time: Number(row.terminal),
          terminal: Number(row.terminal),
        }, scope);
      }
      return terminal;
    }, tx);
  }
  tokens(): Record<string, number> {
    return Object.fromEntries(
      this.db.connection.prepare(
        "SELECT session,terminal FROM session_finishes WHERE terminal>0",
      ).all().map((row) => [String(row.session), Number(row.terminal)]),
    );
  }
}
