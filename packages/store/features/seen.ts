// SPDX-License-Identifier: LGPL-3.0-only
import type { OtkDb } from "../db.ts";
import type { FeatureMigrations } from "../migrations.ts";
import { key } from "./metadata.ts";
import { Changes } from "../changes.ts";
export const seenMigrations: FeatureMigrations = {
  feature: "seen",
  migrations: [{
    version: 1,
    sql: new URL("./migrations/seen/001.sql", import.meta.url),
  }],
};
export class Seen
  extends Changes<{ user: string; session: string; time: number }> {
  constructor(readonly db: OtkDb, readonly now: () => number = Date.now) {
    super(db);
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
    const row = this.db.connection.prepare(
      "INSERT INTO session_seen VALUES(?,?,?) ON CONFLICT(user,session) DO UPDATE SET time=MAX(time,excluded.time) RETURNING time",
    ).get(key(user), key(session), this.now())!;
    const time = Number(row.time);
    this.changed({ user, session, time });
    return time;
  }
  all(): { user: string; session: string; time: number }[] {
    return this.db.connection.prepare(
      "SELECT user,session,time FROM session_seen",
    ).all().map((row) => ({
      user: String(row.user),
      session: String(row.session),
      time: Number(row.time),
    }));
  }
}
