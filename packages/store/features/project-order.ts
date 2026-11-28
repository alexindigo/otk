// SPDX-License-Identifier: LGPL-3.0-only
import type { OtkDb, StoreWrite } from "../db.ts";
import { key, MetadataChanges } from "./metadata.ts";

interface ProjectOrderRow {
  id: string;
  root: string;
  repo?: string;
  directories: string[];
}

/** Durable rank and alias writes; admission policy belongs to the server. */
type OrderChange = { user: string; removed?: string[] };
export class ProjectOrderStore extends MetadataChanges<OrderChange> {
  constructor(readonly db: OtkDb) {
    super(db);
  }
  protected override changeKey(value: OrderChange): string {
    return value.user;
  }
  protected override mergeChanges(
    before: OrderChange,
    after: OrderChange,
  ): OrderChange {
    const removed = [
      ...new Set([...before.removed ?? [], ...after.removed ?? []]),
    ];
    return removed.length ? { user: after.user, removed } : after;
  }
  list(user: string): ProjectOrderRow[] {
    const projects = new Map<string, ProjectOrderRow>();
    for (
      const row of this.db.connection.prepare(
        "SELECT id, root, repo FROM project_order WHERE user=? ORDER BY rank",
      ).all(key(user))
    ) {
      const id = String(row.id);
      projects.set(id, {
        id,
        root: String(row.root),
        ...(row.repo === null ? {} : { repo: String(row.repo) }),
        directories: [],
      });
    }
    for (
      const row of this.db.connection.prepare(
        "SELECT id, directory FROM project_order_aliases WHERE user=? ORDER BY id, ordinal, directory",
      ).all(user)
    ) projects.get(String(row.id))!.directories.push(String(row.directory));
    return [...projects.values()];
  }
  alias(user: string, directory: string): string | undefined {
    const row = this.db.connection.prepare(
      "SELECT id FROM project_order_aliases WHERE user=? AND directory=?",
    ).get(key(user), key(directory));
    return row && String(row.id);
  }
  /** Evidence can fill a missing repository without touching the rank. */
  rememberRepository(
    user: string,
    root: string,
    repo: string,
    tx: StoreWrite,
  ): void {
    this.db.write(() => {
      this.db.connection.prepare(
        "UPDATE project_order SET repo=? WHERE user=? AND root=? AND repo IS NULL",
      ).run(repo, key(user), key(root));
    }, tx);
  }
  create(user: string, root: string, repo?: string, tx?: StoreWrite): string {
    return this.db.write((scope) => {
      const id = crypto.randomUUID();
      this.db.connection.prepare(
        "INSERT INTO project_order(user,id,rank,repo,root) SELECT ?,?,COALESCE(MAX(rank)+1,0),?,? FROM project_order WHERE user=?",
      ).run(key(user), id, repo ?? null, key(root), user);
      this.db.connection.prepare(
        "INSERT INTO project_order_aliases VALUES (?,?,?,0)",
      ).run(user, root, id);
      this.changed({ user }, scope);
      return id;
    }, tx);
  }
  attach(user: string, directory: string, id: string, tx?: StoreWrite): void {
    this.db.write((scope) => {
      const previous = this.alias(user, directory);
      if (previous === id) return;
      if (
        !this.db.connection.prepare(
          "SELECT 1 FROM project_order WHERE user=? AND id=?",
        ).get(user, key(id))
      ) throw new Error("Unknown project");
      this.db.connection.prepare(
        "INSERT INTO project_order_aliases(user,directory,id,ordinal) SELECT ?,?,?,COALESCE(MAX(ordinal)+1,0) FROM project_order_aliases WHERE user=? AND id=? ON CONFLICT(user,directory) DO UPDATE SET id=excluded.id, ordinal=excluded.ordinal",
      ).run(user, directory, id, user, id);
      const removed = previous && this.db.connection.prepare(
          "DELETE FROM project_order WHERE user=? AND id=? AND NOT EXISTS (SELECT 1 FROM project_order_aliases WHERE user=? AND id=?)",
        ).run(user, previous, user, previous).changes
        ? previous
        : undefined;
      if (removed) this.#ranks(user, this.#ids(user));
      this.changed({ user, ...(removed ? { removed: [removed] } : {}) }, scope);
    }, tx);
  }
  split(
    user: string,
    directory: string,
    afterID: string,
    tx: StoreWrite,
    repo?: string,
  ): string {
    return this.db.write((scope) => {
      const ids = this.#ids(user);
      const index = ids.indexOf(afterID);
      if (index < 0 || this.alias(user, directory) !== afterID) {
        throw new Error("Unknown project member");
      }
      const id = crypto.randomUUID();
      this.db.connection.prepare("INSERT INTO project_order VALUES (?,?,?,?,?)")
        .run(user, id, ids.length, repo ?? null, directory);
      this.db.connection.prepare(
        "UPDATE project_order_aliases SET id=?, ordinal=0 WHERE user=? AND directory=?",
      )
        .run(id, user, directory);
      ids.splice(index + 1, 0, id);
      this.#ranks(user, ids);
      this.changed({ user }, scope);
      return id;
    }, tx);
  }
  reroot(
    user: string,
    id: string,
    root: string,
    tx?: StoreWrite,
    repo?: string,
  ): void {
    this.db.write((scope) => {
      if (this.alias(user, root) !== id) {
        throw new Error("Unknown project root");
      }
      const previous = this.db.connection.prepare(
        "SELECT root FROM project_order WHERE user=? AND id=?",
      ).get(user, id)?.root;
      if (previous === root) return;
      const ordinal = this.db.connection.prepare(
        "SELECT ordinal FROM project_order_aliases WHERE user=? AND directory=?",
      ).get(user, root)!.ordinal;
      this.db.connection.prepare(
        "UPDATE project_order_aliases SET ordinal=CASE directory WHEN ? THEN 0 ELSE ordinal+1 END WHERE user=? AND id=? AND ordinal<=?",
      ).run(root, user, id, Number(ordinal));
      this.db.connection.prepare(
        "UPDATE project_order SET root=?, repo=COALESCE(?,repo) WHERE user=? AND id=?",
      ).run(root, repo ?? null, user, id);
      this.changed({ user }, scope);
    }, tx);
  }
  #ids(user: string): string[] {
    return this.db.connection.prepare(
      "SELECT id FROM project_order WHERE user=? ORDER BY rank",
    ).all(key(user)).map((row) => String(row.id));
  }
  #ranks(user: string, ids: string[]): void {
    const statement = this.db.connection.prepare(
      "UPDATE project_order SET rank=? WHERE user=? AND id=? AND rank<>?",
    );
    ids.forEach((id, rank) => statement.run(rank, user, id, rank));
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
        throw new Error("Cannot move a project relative to itself");
      }
      const ids = this.#ids(user);
      const from = ids.indexOf(id);
      if (from < 0 || !ids.includes(anchor)) throw new Error("Unknown project");
      ids.splice(from, 1);
      const to = ids.indexOf(anchor) + ("after" in target ? 1 : 0);
      if (from === to) return;
      ids.splice(to, 0, id);
      this.#ranks(user, ids);
      this.changed({ user }, scope);
    }, tx);
  }
  legacy(user: string): { directory: string; position: number }[] {
    return this.db.connection.prepare(
      "SELECT directory, position FROM project_order_legacy WHERE user=? ORDER BY position, directory",
    ).all(key(user)).map((row) => ({
      directory: String(row.directory),
      position: Number(row.position),
    }));
  }
  dropLegacy(user: string, tx?: StoreWrite): void {
    this.db.write(() => {
      this.db.connection.prepare(
        "DELETE FROM project_order_legacy WHERE user=?",
      ).run(key(user));
    }, tx);
  }
}
