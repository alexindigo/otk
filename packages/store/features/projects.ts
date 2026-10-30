// SPDX-License-Identifier: LGPL-3.0-only
import type { OtkDb, StoreWrite } from "../db.ts";
import type { FeatureMigrations } from "../migrations.ts";
import { key } from "./metadata.ts";
import { Changes } from "../changes.ts";
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
export type ProjectChange = { user: string; project: ProjectRecord } | {
  discovered: true;
};
export class Projects extends Changes<ProjectChange> {
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
  discover(directory: string, tx?: StoreWrite): void {
    this.db.write((scope) => {
      const result = this.db.connection.prepare(
        "INSERT OR IGNORE INTO project_directories SELECT ?, COALESCE(MAX(position)+1,0), ? FROM project_directories",
      ).run(key(directory), this.now());
      if (result.changes) this.changed({ discovered: true }, scope);
    }, tx);
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
  /** Membership lookup without discovering or creating a user project. */
  find(user: string, directory: string): ProjectRecord | undefined {
    const record = this.db.connection.prepare(
      "SELECT * FROM projects WHERE user=? AND directory=?",
    ).get(key(user), key(directory));
    return record ? this.#record(record) : undefined;
  }
  add(user: string, directory: string, tx?: StoreWrite): ProjectRecord {
    return this.db.write((scope) => {
      this.list(user);
      this.db.connection.prepare(
        "INSERT INTO projects(user,directory,position,added,last_visit) SELECT ?,?,COALESCE(MAX(position)+1,0),1,? FROM projects WHERE user=? ON CONFLICT(user,directory) DO UPDATE SET added=1",
      ).run(user, key(directory), this.now(), user);
      const project = this.get(user, directory);
      this.changed({ user, project }, scope);
      return project;
    }, tx);
  }
  visit(user: string, directory: string, tx?: StoreWrite): ProjectRecord {
    return this.db.write((scope) => {
      this.get(user, directory);
      const now = this.now();
      this.db.connection.prepare(
        "UPDATE projects SET last_visit=?, inactive_at=CASE WHEN inactive=1 THEN ? ELSE NULL END WHERE user=? AND directory=?",
      ).run(now, now, user, directory);
      const project = this.get(user, directory);
      this.changed({ user, project }, scope);
      return project;
    }, tx);
  }
  inactive(
    user: string,
    directory: string,
    inactive: boolean,
    tx?: StoreWrite,
  ): ProjectRecord {
    return this.db.write((scope) => {
      const previous = this.get(user, directory), now = this.now();
      if (previous.inactive === inactive) return previous;
      const visit = !inactive && previous.inactiveAt !== undefined
        ? previous.lastVisit + Math.max(0, now - previous.inactiveAt)
        : previous.lastVisit;
      this.db.connection.prepare(
        "UPDATE projects SET inactive=?, inactive_at=?, last_visit=? WHERE user=? AND directory=?",
      ).run(inactive ? 1 : 0, inactive ? now : null, visit, user, directory);
      const project = this.get(user, directory);
      this.changed({ user, project }, scope);
      return project;
    }, tx);
  }
  users(): string[] {
    return this.db.connection.prepare("SELECT DISTINCT user FROM projects")
      .all().map((r) => String(r.user));
  }
  policies(): { user: string; directory: string; inactive: boolean }[] {
    return this.db.connection.prepare(
      "SELECT user,directory,inactive FROM projects",
    ).all().map((r) => ({
      user: String(r.user),
      directory: String(r.directory),
      inactive: !!r.inactive,
    }));
  }
  /** Activity path needs no baseline SELECT; return the committed changed fact. */
  reactivate(user: string, directory: string, tx?: StoreWrite): void {
    this.db.write((scope) => {
      const now = this.now();
      const row = this.db.connection.prepare(
        "UPDATE projects SET inactive=0,last_visit=last_visit+max(0,?-coalesce(inactive_at,?)),inactive_at=NULL WHERE user=? AND directory=? AND inactive=1 RETURNING *",
      ).get(now, now, key(user), key(directory));
      if (row) this.changed({ user, project: this.#record(row) }, scope);
    }, tx);
  }
}
