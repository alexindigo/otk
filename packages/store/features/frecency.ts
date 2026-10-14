// SPDX-License-Identifier: LGPL-3.0-only
import { resolve } from "@std/path";
import type { OtkDb } from "../db.ts";
import type { Migration } from "../migrations.ts";

/** The frecency feature contributes the original version 2 schema. */
export const frecencyMigrations: readonly Migration[] = [
  { id: 2, sql: new URL("./migrations/002_frecency.sql", import.meta.url) },
];

/** Stored frequency score and last-use time; decay belongs to the consumer. */
export interface FrecencyEntry {
  path: string;
  score: number;
  last: number;
}

/** Application-specific error construction for invalid path keys. */
export interface FrecencyOptions {
  readonly invalid: () => Error;
}

function key(value: string, options: FrecencyOptions): string {
  if (!value.length || value.length > 4096 || value.includes("\0")) {
    throw options.invalid();
  }
  return value;
}
/** Canonical path persistence with a global 1000-entry bound. */
export class Frecency {
  constructor(readonly db: OtkDb, readonly options: FrecencyOptions) {}
  #key(value: string): string {
    return key(value, this.options);
  }
  list(directory: string): FrecencyEntry[] {
    return this.db.connection.prepare(
      "SELECT path,score,last FROM frecency WHERE directory=? ORDER BY last DESC LIMIT 1000",
    ).all(this.#key(resolve(this.#key(directory)))).map((row) => ({
      path: String(row.path),
      score: Number(row.score),
      last: Number(row.last),
    }));
  }
  bump(directory: string, path: string): void {
    const canonicalDirectory = this.#key(resolve(this.#key(directory)));
    const canonicalPath = this.#key(
      resolve(canonicalDirectory, this.#key(path)),
    );
    this.db.connection.prepare(
      "INSERT INTO frecency(directory,path,score,last) VALUES(?,?,1,?) ON CONFLICT(directory,path) DO UPDATE SET score=frecency.score+1,last=excluded.last",
    ).run(canonicalDirectory, canonicalPath, Date.now());
    this.db.connection.prepare(
      "DELETE FROM frecency WHERE rowid NOT IN (SELECT rowid FROM frecency ORDER BY last DESC,rowid DESC LIMIT 1000)",
    ).run();
  }
}
