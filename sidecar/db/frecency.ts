// SPDX-License-Identifier: LGPL-3.0-only
import { resolve } from "@std/path";
import type { FrecencyEntry } from "@otk/protocol";
import type { OtkDb } from "./db.ts";
import { HarnessError } from "../adapter/types.ts";
function key(value: string): string {
  if (!value.length || value.length > 4096 || value.includes("\0")) {
    throw new HarnessError("params", "Invalid frecency path length or value");
  }
  return value;
}
export class Frecency {
  constructor(readonly db: OtkDb) {}
  list(directory: string): FrecencyEntry[] {
    return this.db.connection.prepare(
      "SELECT path,score,last FROM frecency WHERE directory=? ORDER BY last DESC LIMIT 1000",
    ).all(key(resolve(key(directory)))).map((row) => ({
      path: String(row.path),
      score: Number(row.score),
      last: Number(row.last),
    }));
  }
  bump(directory: string, path: string): void {
    const canonicalDirectory = key(resolve(key(directory)));
    const canonicalPath = key(resolve(canonicalDirectory, key(path)));
    this.db.connection.prepare(
      "INSERT INTO frecency(directory,path,score,last) VALUES(?,?,1,?) ON CONFLICT(directory,path) DO UPDATE SET score=frecency.score+1,last=excluded.last",
    ).run(canonicalDirectory, canonicalPath, Date.now());
    this.db.connection.prepare(
      "DELETE FROM frecency WHERE rowid NOT IN (SELECT rowid FROM frecency ORDER BY last DESC,rowid DESC LIMIT 1000)",
    ).run();
  }
}
