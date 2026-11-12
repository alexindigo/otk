// SPDX-License-Identifier: LGPL-3.0-only
import type { OtkDb, StoreWrite } from "../db.ts";
import type { FeatureMigrations } from "../migrations.ts";
import { key, MetadataChanges } from "./metadata.ts";
export const seenMigrations: FeatureMigrations = {
  feature: "seen",
  migrations: [{
    version: 1,
    sql: new URL("./migrations/seen/001.sql", import.meta.url),
  }, {
    version: 2,
    sql:
      "ALTER TABLE session_seen ADD COLUMN terminal INTEGER NOT NULL DEFAULT 0;",
  }],
};
export interface SeenChange {
  user: string;
  session: string;
  time: number;
  terminal?: number;
}
export class Seen extends MetadataChanges<SeenChange> {
  protected override changeKey(value: SeenChange): string {
    return JSON.stringify([value.user, value.session]);
  }
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
  mark(user: string, session: string, tx?: StoreWrite): number {
    return this.db.write((scope) => {
      const row = this.db.connection.prepare(
        "INSERT INTO session_seen(user,session,time) VALUES(?,?,?) ON CONFLICT(user,session) DO UPDATE SET time=MAX(time,excluded.time) RETURNING time",
      ).get(key(user), key(session), this.now())!;
      const time = Number(row.time);
      this.changed({ user, session, time }, scope);
      return time;
    }, tx);
  }
  /** Acknowledge only the provider terminal that was actually displayed. */
  acknowledge(
    user: string,
    session: string,
    terminal: number,
    tx?: StoreWrite,
  ): number {
    if (!Number.isSafeInteger(terminal) || terminal < 0) {
      throw new TypeError("Invalid terminal token");
    }
    return this.db.write((scope) => {
      const row = this.db.connection.prepare(
        "INSERT INTO session_seen(user,session,time,terminal) VALUES(?,?,0,?) ON CONFLICT(user,session) DO UPDATE SET terminal=MAX(terminal,excluded.terminal) RETURNING terminal",
      ).get(key(user), key(session), terminal)!;
      const time = Number(row.terminal);
      this.changed({ user, session, time, terminal: time }, scope);
      return time;
    }, tx);
  }
  tokens(): SeenChange[] {
    return this.db.connection.prepare(
      "SELECT user,session,terminal FROM session_seen",
    ).all().map((row) => ({
      user: String(row.user),
      session: String(row.session),
      time: Number(row.terminal),
    }));
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
