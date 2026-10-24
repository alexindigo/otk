// SPDX-License-Identifier: LGPL-3.0-only
import type { OtkDb } from "../db.ts";
import type { FeatureMigrations } from "../migrations.ts";
import { key, MetadataChanges } from "./metadata.ts";
export const projectsMigrations: FeatureMigrations = {
  feature: "projects",
  migrations: [{
    version: 1,
    sql: new URL("./migrations/projects/001.sql", import.meta.url),
  }],
};
export interface ProjectRecord {
  directory: string;
  order: number;
  added: boolean;
  inactive: boolean;
  lastVisit: number;
  inactiveAt?: number;
}
export class Projects extends MetadataChanges {
  constructor(readonly db: OtkDb, readonly now: () => number = Date.now) {
    super(db);
  }
  #record(r: Record<string, unknown>): ProjectRecord {
    return {
      directory: String(r.directory),
      order: Number(r.position),
      added: !!r.added,
      inactive: !!r.inactive,
      lastVisit: Number(r.last_visit),
      ...(r.inactive_at === null ? {} : { inactiveAt: Number(r.inactive_at) }),
    };
  }
  discover(directory: string): void {
    const result = this.db.connection.prepare(
      "INSERT OR IGNORE INTO project_directories SELECT ?, COALESCE(MAX(position)+1,0), ? FROM project_directories",
    ).run(key(directory), this.now());
    if (result.changes) this.changed();
  }
  list(user: string): ProjectRecord[] {
    key(user);
    const missing = this.db.connection.prepare(
      "SELECT directory,discovered FROM project_directories WHERE directory NOT IN (SELECT directory FROM projects WHERE user=?) ORDER BY position",
    ).all(user);
    for (const row of missing) {
      this.db.connection.prepare(
        "INSERT OR IGNORE INTO projects(user,directory,position,last_visit) SELECT ?,?,COALESCE(MAX(position)+1,0),? FROM projects WHERE user=?",
      ).run(user, String(row.directory), Number(row.discovered), user);
    }
    return this.db.connection.prepare(
      "SELECT * FROM projects WHERE user=? ORDER BY position, directory",
    ).all(user).map((r) => this.#record(r));
  }
  get(user: string, directory: string): ProjectRecord {
    const query = this.db.connection.prepare(
      "SELECT * FROM projects WHERE user=? AND directory=?",
    );
    let record = query.get(key(user), key(directory));
    if (!record) {
      this.list(user);
      record = query.get(user, directory);
    }
    if (!record) throw new Error("Unknown project");
    return this.#record(record);
  }
  add(user: string, directory: string): ProjectRecord {
    this.list(user);
    this.db.connection.prepare(
      "INSERT INTO projects(user,directory,position,added,last_visit) SELECT ?,?,COALESCE(MAX(position)+1,0),1,? FROM projects WHERE user=? ON CONFLICT(user,directory) DO UPDATE SET added=1",
    ).run(user, key(directory), this.now(), user);
    this.changed();
    return this.get(user, directory);
  }
  visit(user: string, directory: string): ProjectRecord {
    this.get(user, directory);
    const now = this.now();
    this.db.connection.prepare(
      "UPDATE projects SET last_visit=?, inactive_at=CASE WHEN inactive=1 THEN ? ELSE NULL END WHERE user=? AND directory=?",
    ).run(now, now, user, directory);
    this.changed();
    return this.get(user, directory);
  }
  inactive(user: string, directory: string, inactive: boolean): ProjectRecord {
    const previous = this.get(user, directory), now = this.now();
    if (previous.inactive === inactive) return previous;
    const visit = !inactive && previous.inactiveAt !== undefined
      ? previous.lastVisit + Math.max(0, now - previous.inactiveAt)
      : previous.lastVisit;
    this.db.connection.prepare(
      "UPDATE projects SET inactive=?, inactive_at=?, last_visit=? WHERE user=? AND directory=?",
    ).run(inactive ? 1 : 0, inactive ? now : null, visit, user, directory);
    this.changed();
    return this.get(user, directory);
  }
  users(): string[] {
    return this.db.connection.prepare("SELECT DISTINCT user FROM projects")
      .all().map((r) => String(r.user));
  }
}
