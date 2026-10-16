// SPDX-License-Identifier: LGPL-3.0-only
import type { OtkDb } from "../db.ts";
import type { FeatureMigrations } from "../migrations.ts";
import { key, MetadataChanges } from "./metadata.ts";
export const seenMigrations: FeatureMigrations = {
  feature: "seen",
  migrations: [{
    version: 1,
    sql: new URL("./migrations/seen/001.sql", import.meta.url),
  }],
};
export class Seen extends MetadataChanges {
  constructor(readonly db: OtkDb, readonly now: () => number = Date.now) {
    super();
  }
  time(user: string, session: string): number {
    return Number(
      this.db.connection.prepare(
        "SELECT time FROM session_seen WHERE user=? AND session=?",
      ).get(key(user), key(session))?.time ?? 0,
    );
  }
  list(user: string): Record<string, number> {
    return Object.fromEntries(
      this.db.connection.prepare(
        "SELECT session,time FROM session_seen WHERE user=?",
      ).all(key(user)).map((r) => [String(r.session), Number(r.time)]),
    );
  }
  mark(user: string, session: string): number {
    this.db.connection.prepare(
      "INSERT INTO session_seen VALUES(?,?,?) ON CONFLICT(user,session) DO UPDATE SET time=MAX(time,excluded.time)",
    ).run(key(user), key(session), this.now());
    this.changed();
    return this.time(user, session);
  }
}
