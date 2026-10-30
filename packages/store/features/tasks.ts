// SPDX-License-Identifier: LGPL-3.0-only
import type { OtkDb, StoreWrite } from "../db.ts";
import type { FeatureMigrations } from "../migrations.ts";
import { key, MetadataChanges, ordered } from "./metadata.ts";
export const tasksMigrations: FeatureMigrations = {
  feature: "tasks",
  migrations: [{
    version: 1,
    sql: new URL("./migrations/tasks/001.sql", import.meta.url),
  }],
};
export interface TaskRecord {
  id: string;
  directory: string;
  name: string;
  order: number;
  sessions: string[];
}
export class Tasks extends MetadataChanges {
  constructor(readonly db: OtkDb) {
    super(db);
  }
  list(directory?: string): TaskRecord[] {
    return this.db.connection.prepare(
      "SELECT * FROM tasks ORDER BY position,id",
    ).all().filter((r) => directory === undefined || r.directory === directory)
      .map((r) => ({
        id: String(r.id),
        directory: String(r.directory),
        name: String(r.name),
        order: Number(r.position),
        sessions: this.db.connection.prepare(
          "SELECT session FROM task_sessions WHERE task=? ORDER BY position",
        ).all(String(r.id)).map((s) => String(s.session)),
      }));
  }
  get(id: string): TaskRecord {
    const task = this.list().find((t) => t.id === key(id));
    if (!task) throw new Error("Unknown task");
    return task;
  }
  create(
    directory: string,
    name: string,
    sessions: string[] = [],
    tx?: StoreWrite,
  ): TaskRecord {
    return this.db.write((scope) => {
      const id = crypto.randomUUID();
      key(directory);
      key(name);
      ordered(sessions);
      this.db.connection.prepare(
        "INSERT INTO tasks SELECT ?,?,?,COALESCE(MAX(position)+1,0) FROM tasks WHERE directory=?",
      ).run(id, directory, name, directory);
      sessions.forEach((session, i) =>
        this.db.connection.prepare("INSERT INTO task_sessions VALUES(?,?,?)")
          .run(id, session, i)
      );
      this.changed(undefined, scope);
      return this.get(id);
    }, tx);
  }
  rename(id: string, name: string, tx?: StoreWrite): TaskRecord {
    return this.db.write((scope) => {
      this.get(id);
      this.db.connection.prepare("UPDATE tasks SET name=? WHERE id=?").run(
        key(name),
        id,
      );
      this.changed(undefined, scope);
      return this.get(id);
    }, tx);
  }
  reorder(directory: string, ids: string[], tx?: StoreWrite): TaskRecord[] {
    return this.db.write((scope) => {
      ordered(ids);
      const existing = this.list(key(directory)).map((t) => t.id);
      if (
        ids.length !== existing.length ||
        ids.some((id) => !existing.includes(id))
      ) throw new Error("Expected all project tasks");
      ids.forEach((id, i) =>
        this.db.connection.prepare("UPDATE tasks SET position=? WHERE id=?")
          .run(i, id)
      );
      this.changed(undefined, scope);
      return this.list(directory);
    }, tx);
  }
  sessions(id: string, sessions: string[], tx?: StoreWrite): TaskRecord {
    return this.db.write((scope) => {
      this.get(id);
      ordered(sessions);
      this.db.connection.prepare("DELETE FROM task_sessions WHERE task=?").run(
        id,
      );
      for (const [i, session] of sessions.entries()) {
        this.db.connection.prepare("INSERT INTO task_sessions VALUES(?,?,?)")
          .run(id, session, i);
      }
      this.changed(undefined, scope);
      return this.get(id);
    }, tx);
  }
  addSession(id: string, sessionID: string, tx?: StoreWrite): TaskRecord {
    return this.db.write((scope) => {
      key(sessionID);
      this.get(id);
      this.db.connection.prepare(
        "INSERT INTO task_sessions SELECT ?,?,COALESCE(MAX(position)+1,0) FROM task_sessions WHERE task=? ON CONFLICT(task,session) DO NOTHING",
      ).run(id, sessionID, id);
      this.changed(undefined, scope);
      return this.get(id);
    }, tx);
  }
  removeSession(id: string, sessionID: string, tx?: StoreWrite): TaskRecord {
    return this.db.write((scope) => {
      key(sessionID);
      this.get(id);
      this.db.connection.prepare(
        "DELETE FROM task_sessions WHERE task=? AND session=?",
      ).run(id, sessionID);
      this.changed(undefined, scope);
      return this.get(id);
    }, tx);
  }
  close(id: string, tx?: StoreWrite): void {
    this.db.write((scope) => {
      this.get(id);
      this.db.connection.prepare("DELETE FROM task_sessions WHERE task=?").run(
        id,
      );
      this.db.connection.prepare("DELETE FROM tasks WHERE id=?").run(id);
      this.changed(undefined, scope);
    }, tx);
  }
}
