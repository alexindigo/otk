// SPDX-License-Identifier: LGPL-3.0-only
import type { OtkDb, StoreWrite } from "../db.ts";
import type { FeatureMigrations } from "../migrations.ts";
import { key, MetadataChanges, validateKey } from "./metadata.ts";

export const programsMigrations: FeatureMigrations = {
  feature: "programs",
  migrations: [{
    version: 1,
    sql: new URL("./migrations/programs/001.sql", import.meta.url),
  }],
};

interface ProgramRow {
  id: string;
  rank: number;
  name: string | null;
  owner: string | null;
  dismissed: boolean;
}
function nameOf(name: string): string {
  return validateKey(name.trim(), {
    maxLength: 80,
    blank: false,
    invalid: () => new Error("Program name must contain 1 to 80 characters"),
  });
}

/** Durable choices only; the application owns membership derivation. */
export class ProgramStore extends MetadataChanges<{ user: string }> {
  constructor(readonly db: OtkDb) {
    super(db);
  }
  protected override changeKey({ user }: { user: string }): string {
    return user;
  }
  list(user: string): ProgramRow[] {
    return this.db.connection.prepare(
      "SELECT id,rank,name,owner,dismissed FROM programs WHERE user=? ORDER BY rank",
    ).all(key(user)).map((r) => ({
      id: String(r.id),
      rank: Number(r.rank),
      name: r.name as string | null,
      owner: r.owner as string | null,
      dismissed: r.dismissed === 1,
    }));
  }
  members(user: string): Map<string, string | null> {
    return new Map(
      this.db.connection.prepare(
        "SELECT project,program FROM program_members WHERE user=?",
      ).all(key(user)).map((
        r,
      ) => [String(r.project), r.program as string | null]),
    );
  }
  #insert(
    user: string,
    name: string | null,
    owner: string | null,
    tx: StoreWrite,
  ): string {
    const id = crypto.randomUUID();
    this.db.connection.prepare(
      "INSERT INTO programs(user,id,rank,name,owner) SELECT ?,?,COALESCE(MAX(rank)+1,0),?,? FROM programs WHERE user=?",
    ).run(key(user), id, name, owner, user);
    this.changed({ user }, tx);
    return id;
  }
  create(user: string, name: string, tx?: StoreWrite): string {
    return this.db.write(
      (scope) => this.#insert(user, nameOf(name), null, scope),
      tx,
    );
  }
  ensureAuto(user: string, owner: string, tx?: StoreWrite): string {
    return this.db.write((scope) => {
      const row = this.db.connection.prepare(
        "SELECT id FROM programs WHERE user=? AND owner=?",
      )
        .get(key(user), key(owner));
      return row ? String(row.id) : this.#insert(user, null, owner, scope);
    }, tx);
  }
  #active(user: string, id: string) {
    const row = this.db.connection.prepare(
      "SELECT owner FROM programs WHERE user=? AND id=? AND dismissed=0",
    ).get(key(user), key(id));
    if (!row) throw new Error("Unknown program");
    return row;
  }
  rename(user: string, id: string, name: string, tx?: StoreWrite): void {
    this.db.write((scope) => {
      this.#active(user, id);
      const value = nameOf(name);
      if (
        this.db.connection.prepare(
          "UPDATE programs SET name=? WHERE user=? AND id=? AND name IS NOT ?",
        ).run(value, user, id, value).changes
      ) this.changed({ user }, scope);
    }, tx);
  }
  #delete(user: string, id: string, dismiss: boolean, tx?: StoreWrite): void {
    this.db.write((scope) => {
      if ((this.#active(user, id).owner !== null) !== dismiss) {
        throw new Error("Unexpected program origin");
      }
      this.db.connection.prepare(
        dismiss
          ? "UPDATE programs SET dismissed=1 WHERE user=? AND id=?"
          : "DELETE FROM programs WHERE user=? AND id=?",
      ).run(user, id);
      this.db.connection.prepare(
        "DELETE FROM program_members WHERE user=? AND program=?",
      ).run(user, id);
      if (!dismiss) this.#ranks(user, this.list(user).map((row) => row.id));
      this.changed({ user }, scope);
    }, tx);
  }
  remove(user: string, id: string, tx?: StoreWrite): void {
    this.#delete(user, id, false, tx);
  }
  dismiss(user: string, id: string, tx?: StoreWrite): void {
    this.#delete(user, id, true, tx);
  }
  #ranks(user: string, ids: string[]): void {
    const update = this.db.connection.prepare(
      "UPDATE programs SET rank=? WHERE user=? AND id=? AND rank<>?",
    );
    ids.forEach((id, rank) => update.run(rank, user, id, rank));
  }
  move(
    user: string,
    id: string,
    target: { before: string } | { after: string },
    tx?: StoreWrite,
  ): void {
    this.db.write((scope) => {
      const anchor = "before" in target ? target.before : target.after;
      if (id === anchor) {
        throw new Error("Cannot move a program relative to itself");
      }
      this.#active(user, id);
      this.#active(user, anchor);
      const ids = this.list(user).map((row) => row.id);
      const from = ids.indexOf(id);
      ids.splice(from, 1);
      const to = ids.indexOf(anchor) + ("after" in target ? 1 : 0);
      if (from === to) return;
      ids.splice(to, 0, id);
      this.#ranks(user, ids);
      this.changed({ user }, scope);
    }, tx);
  }
  assign(
    user: string,
    project: string,
    program: string | null,
    tx?: StoreWrite,
  ): void {
    this.db.write((scope) => {
      if (program !== null) this.#active(user, program);
      if (
        this.db.connection.prepare(
          "INSERT INTO program_members(user,project,program) VALUES (?,?,?) ON CONFLICT(user,project) DO UPDATE SET program=excluded.program WHERE program IS NOT excluded.program",
        ).run(key(user), key(project), program).changes
      ) this.changed({ user }, scope);
    }, tx);
  }
  unassign(user: string, project: string, tx?: StoreWrite): void {
    this.forget(user, [project], tx);
  }
  forget(user: string, projects: readonly string[], tx?: StoreWrite): void {
    this.db.write((scope) => {
      const remove = this.db.connection.prepare(
        "DELETE FROM program_members WHERE user=? AND project=?",
      );
      let count = 0;
      for (const project of projects) {
        count += Number(remove.run(key(user), key(project)).changes);
      }
      if (count) this.changed({ user }, scope);
    }, tx);
  }
  auto(user: string): boolean {
    return this.db.connection.prepare(
      "SELECT auto FROM program_settings WHERE user=?",
    )
      .get(key(user))?.auto === 1;
  }
  setAuto(user: string, value: boolean, tx?: StoreWrite): void {
    this.db.write((scope) => {
      if (this.auto(user) === value) return;
      this.db.connection.prepare(
        "INSERT INTO program_settings VALUES (?,?) ON CONFLICT(user) DO UPDATE SET auto=excluded.auto",
      )
        .run(user, Number(value));
      this.changed({ user }, scope);
    }, tx);
  }
}
