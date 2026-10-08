// SPDX-License-Identifier: LGPL-3.0-only
import { DatabaseSync } from "node:sqlite";
import { join } from "@std/path";
export class OtkDb {
  readonly connection: DatabaseSync;
  constructor(statePath: string) {
    Deno.mkdirSync(statePath, { recursive: true, mode: 0o700 });
    const db = this.connection = new DatabaseSync(join(statePath, "otk.db"));
    try {
      db.exec("PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000");
      const version = Number(
        db.prepare("PRAGMA user_version").get()!.user_version,
      );
      const migrations = [
        new URL("./migrations/001_prefs.sql", import.meta.url),
      ];
      if (version > migrations.length) {
        throw new Error(`Unsupported otk.db schema ${version}`);
      }
      for (let i = version; i < migrations.length; i++) {
        const sql = Deno.readTextFileSync(migrations[i]);
        db.exec("BEGIN IMMEDIATE");
        try {
          db.exec(sql);
          db.exec(`PRAGMA user_version=${i + 1}; COMMIT`);
        } catch (error) {
          db.exec("ROLLBACK");
          throw error;
        }
      }
    } catch (error) {
      db.close();
      throw error;
    }
  }
  close(): void {
    this.connection.close();
  }
}
