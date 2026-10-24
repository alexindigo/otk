// SPDX-License-Identifier: LGPL-3.0-only
import type { OtkDb } from "../db.ts";
import type { FeatureMigrations } from "../migrations.ts";
import { key, MetadataChanges } from "./metadata.ts";
export const finishesMigrations: FeatureMigrations = {
  feature: "finishes",
  migrations: [{
    version: 1,
    sql: new URL("./migrations/finishes/001.sql", import.meta.url),
  }],
};
export class Finishes extends MetadataChanges {
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
  record(session: string): number {
    this.db.connection.prepare(
      "INSERT INTO session_finishes VALUES(?,?) ON CONFLICT(session) DO UPDATE SET time=MAX(time,excluded.time)",
    ).run(key(session), this.now());
    this.changed();
    return this.time(session);
  }
}
