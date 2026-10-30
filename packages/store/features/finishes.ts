// SPDX-License-Identifier: LGPL-3.0-only
import type { OtkDb, StoreWrite } from "../db.ts";
import type { FeatureMigrations } from "../migrations.ts";
import { key, MetadataChanges } from "./metadata.ts";
export const finishesMigrations: FeatureMigrations = {
  feature: "finishes",
  migrations: [{
    version: 1,
    sql: new URL("./migrations/finishes/001.sql", import.meta.url),
  }],
};
export interface FinishChange {
  session: string;
  time: number;
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
        "INSERT INTO session_finishes VALUES(?,?) ON CONFLICT(session) DO UPDATE SET time=MAX(time,excluded.time) RETURNING time",
      ).get(key(session), this.now())!;
      const time = Number(row.time);
      this.changed({ session, time }, scope);
      return time;
    }, tx);
  }
}
