// SPDX-License-Identifier: LGPL-3.0-only
import type { OtkDb, StoreWrite } from "../db.ts";
import type { FeatureMigrations } from "../migrations.ts";
import { key, mergeRecords, MetadataChanges, ordered } from "./metadata.ts";
export const tasksMigrations: FeatureMigrations = {
  feature: "tasks",
  migrations: [{
    version: 1,
    sql: new URL("./migrations/tasks/001.sql", import.meta.url),
  }, {
    version: 2,
    sql: new URL("./migrations/tasks/002.sql", import.meta.url),
  }],
};
export interface TaskRecord {
  id: string;
  directory: string;
  name: string;
  order: number;
  sessions: string[];
}
export interface TaskChange {
  upsert: TaskRecord[];
  remove: string[];
}
export class Tasks extends MetadataChanges<TaskChange> {
  constructor(readonly db: OtkDb) {
    super(db);
  }
  protected override mergeChanges(
    before: TaskChange,
    after: TaskChange,
  ): TaskChange {
    return mergeRecords(before, after, (task) => task.id);
  }
  #read(where: string, params: string[]): TaskRecord[] {
    const tasks = this.db.connection.prepare(
      `SELECT t.* FROM tasks t ${where} ORDER BY t.position,t.id`,
    ).all(...params).map((r) => ({
      id: String(r.id),
      directory: String(r.directory),
      name: String(r.name),
      order: Number(r.position),
      sessions: [] as string[],
    }));
    const byID = new Map(tasks.map((task) => [task.id, task]));
    const members = this.db.connection.prepare(
      `SELECT s.task,s.session FROM task_sessions s JOIN tasks t ON t.id=s.task ${where} ORDER BY s.task,s.position,s.session`,
    ).all(...params);
    for (const row of members) {
      byID.get(String(row.task))!.sessions.push(String(row.session));
    }
    return tasks;
  }
  list(directory?: string): TaskRecord[] {
    return directory === undefined
      ? this.#read("", [])
      : this.#read("WHERE t.directory=?", [key(directory)]);
  }
  get(id: string): TaskRecord {
    const task = this.#read("WHERE t.id=?", [key(id)])[0];
    if (!task) throw new Error("Unknown task");
    return task;
  }
  getMany(ids: readonly string[]): TaskRecord[] {
    if (!ids.length) return [];
    return this.#read("WHERE t.id IN (SELECT value FROM json_each(?))", [
      JSON.stringify([...new Set(ids.map(key))]),
    ]);
  }
  owner(session: string): string | undefined {
    const row = this.db.connection.prepare(
      "SELECT task FROM task_sessions WHERE session=?",
    ).get(key(session));
    return row ? String(row.task) : undefined;
  }
  owners(sessions: readonly string[]): Record<string, string> {
    if (!sessions.length) return {};
    return Object.fromEntries(
      this.db.connection.prepare(
        "SELECT session,task FROM task_sessions WHERE session IN (SELECT value FROM json_each(?))",
      ).all(JSON.stringify(sessions.map(key))).map((
        r,
      ) => [String(r.session), String(r.task)]),
    );
  }
  #members(id: string, sessions: string[]): void {
    this.db.connection.prepare(
      "INSERT INTO task_sessions(task,session,position) SELECT ?,value,CAST(key AS INTEGER) FROM json_each(?)",
    ).run(id, JSON.stringify(sessions));
  }
  #upsert(task: TaskRecord, tx: StoreWrite): TaskRecord {
    this.changed({ upsert: [task], remove: [] }, tx);
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
      this.#members(id, sessions);
      return this.#upsert(this.get(id), scope);
    }, tx);
  }
  rename(id: string, name: string, tx?: StoreWrite): TaskRecord {
    return this.db.write((scope) => {
      const previous = this.get(id);
      if (previous.name === key(name)) return previous;
      this.db.connection.prepare("UPDATE tasks SET name=? WHERE id=?").run(
        name,
        id,
      );
      return this.#upsert({ ...previous, name }, scope);
    }, tx);
  }
  reorder(directory: string, ids: string[], tx?: StoreWrite): TaskRecord[] {
    return this.db.write((scope) => {
      ordered(ids);
      const existing = this.list(key(directory)), wanted = new Set(ids);
      if (
        ids.length !== existing.length ||
        existing.some((t) => !wanted.has(t.id))
      ) throw new Error("Expected all project tasks");
      const byID = new Map(existing.map((task) => [task.id, task]));
      const result = ids.map((id, order) => ({ ...byID.get(id)!, order }));
      const changed = result.filter((task) =>
        byID.get(task.id)!.order !== task.order
      );
      if (changed.length) {
        this.db.connection.prepare(
          "WITH positions AS (SELECT value AS id,CAST(key AS INTEGER) AS position FROM json_each(?)) UPDATE tasks SET position=(SELECT position FROM positions WHERE positions.id=tasks.id) WHERE id IN (SELECT id FROM positions)",
        ).run(JSON.stringify(ids));
        this.changed({ upsert: changed, remove: [] }, scope);
      }
      return result;
    }, tx);
  }
  sessions(id: string, sessions: string[], tx?: StoreWrite): TaskRecord {
    return this.db.write((scope) => {
      const previous = this.get(id);
      ordered(sessions);
      if (
        sessions.length === previous.sessions.length &&
        sessions.every((s, i) => s === previous.sessions[i])
      ) return previous;
      this.db.connection.prepare("DELETE FROM task_sessions WHERE task=?").run(
        id,
      );
      this.#members(id, sessions);
      return this.#upsert({ ...previous, sessions: [...sessions] }, scope);
    }, tx);
  }
  addSession(id: string, sessionID: string, tx?: StoreWrite): TaskRecord {
    return this.db.write((scope) => {
      key(sessionID);
      const previous = this.get(id);
      const result = this.db.connection.prepare(
        "INSERT INTO task_sessions SELECT ?,?,COALESCE(MAX(position)+1,0) FROM task_sessions WHERE task=? ON CONFLICT(task,session) DO NOTHING",
      ).run(id, sessionID, id);
      return result.changes ? this.#upsert(this.get(id), scope) : previous;
    }, tx);
  }
  removeSession(id: string, sessionID: string, tx?: StoreWrite): TaskRecord {
    return this.db.write((scope) => {
      key(sessionID);
      const previous = this.get(id);
      const result = this.db.connection.prepare(
        "DELETE FROM task_sessions WHERE task=? AND session=?",
      ).run(id, sessionID);
      return result.changes ? this.#upsert(this.get(id), scope) : previous;
    }, tx);
  }
  /** Intentional grouping edits only; provider deletion retains membership. */
  removeSessions(sessions: readonly string[], tx?: StoreWrite): TaskRecord[] {
    if (!sessions.length) return [];
    return this.db.write((scope) => {
      const affected = [...new Set(Object.values(this.owners(sessions)))];
      this.db.connection.prepare(
        "DELETE FROM task_sessions WHERE session IN (SELECT value FROM json_each(?))",
      ).run(JSON.stringify(sessions));
      const upsert = this.getMany(affected);
      if (upsert.length) this.changed({ upsert, remove: [] }, scope);
      return upsert;
    }, tx);
  }
  close(id: string, tx?: StoreWrite): void {
    this.db.write((scope) => {
      this.get(id);
      this.db.connection.prepare("DELETE FROM task_sessions WHERE task=?").run(
        id,
      );
      this.db.connection.prepare("DELETE FROM tasks WHERE id=?").run(id);
      this.changed({ upsert: [], remove: [id] }, scope);
    }, tx);
  }
}
