// SPDX-License-Identifier: LGPL-3.0-only
import { resolve } from "@std/path";
import type { OtkDb, StoreWrite } from "../db.ts";
import type { FeatureMigrations } from "../migrations.ts";
import { mergeRecords, MetadataChanges, validateKey } from "./metadata.ts";
export const FRECENCY_RETENTION = 1000;

/** The frecency feature owns its schema versions independently of preferences. */
export const frecencyMigrations: FeatureMigrations = {
  feature: "frecency",
  migrations: [
    {
      version: 1,
      sql: new URL("./migrations/frecency/001.sql", import.meta.url),
    },
  ],
};

/** Stored frequency score and last-use time; decay belongs to the consumer. */
export interface FrecencyEntry {
  path: string;
  score: number;
  last: number;
}
export interface FrecencyChange {
  directory: string;
  upsert: FrecencyEntry[];
  remove: string[];
}

/** Application-specific error construction for invalid path keys. */
export interface FrecencyOptions {
  readonly invalid: () => Error;
  readonly maxLength: number;
}

function key(value: string, options: FrecencyOptions): string {
  return validateKey(value, { ...options, blank: true });
}
/** Canonical path persistence with a global 1000-entry bound. */
export class Frecency extends MetadataChanges<FrecencyChange> {
  constructor(readonly db: OtkDb, readonly options: FrecencyOptions) {
    super(db);
  }
  protected override changeKey(value: FrecencyChange): string {
    return value.directory;
  }
  protected override mergeChanges(
    before: FrecencyChange,
    after: FrecencyChange,
  ): FrecencyChange {
    return {
      directory: after.directory,
      ...mergeRecords(before, after, (entry) => entry.path),
    };
  }
  #key(value: string): string {
    return key(value, this.options);
  }
  list(directory: string): FrecencyEntry[] {
    return this.db.connection.prepare(
      "SELECT path,score,last FROM frecency WHERE directory=? ORDER BY last DESC,rowid DESC LIMIT ?",
    ).all(this.#key(resolve(this.#key(directory))), FRECENCY_RETENTION).map((
      row,
    ) => ({
      path: String(row.path),
      score: Number(row.score),
      last: Number(row.last),
    }));
  }
  bump(directory: string, path: string, tx?: StoreWrite): number {
    return this.db.write((scope) => {
      const time = Date.now();
      const canonicalDirectory = this.#key(resolve(this.#key(directory)));
      const canonicalPath = this.#key(
        resolve(canonicalDirectory, this.#key(path)),
      );
      const row = this.db.connection.prepare(
        "INSERT INTO frecency(directory,path,score,last) VALUES(?,?,1,?) ON CONFLICT(directory,path) DO UPDATE SET score=frecency.score+1,last=excluded.last RETURNING score,last",
      ).get(canonicalDirectory, canonicalPath, time)!;
      this.changed({
        directory: canonicalDirectory,
        upsert: [{
          path: canonicalPath,
          score: Number(row.score),
          last: Number(row.last),
        }],
        remove: [],
      }, scope);
      const removed = this.db.connection.prepare(
        "DELETE FROM frecency WHERE rowid NOT IN (SELECT rowid FROM frecency ORDER BY last DESC,rowid DESC LIMIT ?) RETURNING directory,path",
      ).all(FRECENCY_RETENTION);
      const directories = new Map<string, string[]>();
      for (const row of removed) {
        const directory = String(row.directory),
          paths = directories.get(directory) ?? [];
        paths.push(String(row.path));
        directories.set(directory, paths);
      }
      for (const [directory, paths] of directories) {
        this.changed({ directory, upsert: [], remove: paths }, scope);
      }
      return time;
    }, tx);
  }
}
