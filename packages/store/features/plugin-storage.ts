// SPDX-License-Identifier: LGPL-3.0-only
import type { OtkDb, StoreWrite } from "../db.ts";
import type { FeatureMigrations } from "../migrations.ts";

export const pluginStorageMigrations: FeatureMigrations = {
  feature: "plugin-storage",
  migrations: [{
    version: 1,
    sql: new URL("./migrations/plugin-storage/001.sql", import.meta.url),
  }],
};
/** SQLite BINARY orders valid text by UTF-8, not JavaScript's UTF-16 order. */
function compareKeys(left: string, right: string): number {
  const encoder = new TextEncoder(),
    a = encoder.encode(left),
    b = encoder.encode(right);
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return a.length - b.length;
}
function prefixUpper(prefix: string): string | undefined {
  const chars = [...prefix];
  for (let i = chars.length - 1; i >= 0; i--) {
    const point = chars[i].codePointAt(0)!;
    if (point < 0x10ffff) {
      return chars.slice(0, i).join("") + String.fromCodePoint(point + 1);
    }
  }
}
/** No harness dependency or record schema: every plugin owns its keys and values. */
export class PluginStore {
  constructor(readonly db: OtkDb) {}
  scope(namespace: string): {
    get(key: string): string | undefined;
    set(key: string, value: string): void;
    delete(key: string): void;
    scan(
      input: { prefix: string; after?: string; limit: number },
    ): { key: string; value: string }[];
    transaction<T>(run: () => T): T;
  } {
    if (!namespace) throw new TypeError("Plugin namespace must not be empty");
    let transaction: StoreWrite | undefined;
    const write = <T>(run: () => T) => this.db.write(run, transaction);
    return {
      get: (key: string): string | undefined => {
        const row = this.db.connection.prepare(
          "SELECT value FROM plugin_storage WHERE namespace=? AND key=?",
        ).get(namespace, key);
        return row ? String(row.value) : undefined;
      },
      set: (key: string, value: string): void => {
        write(() =>
          this.db.connection.prepare(
            "INSERT INTO plugin_storage(namespace,key,value) VALUES(?,?,?) ON CONFLICT(namespace,key) DO UPDATE SET value=excluded.value",
          ).run(namespace, key, value)
        );
      },
      delete: (key: string): void => {
        write(() =>
          this.db.connection.prepare(
            "DELETE FROM plugin_storage WHERE namespace=? AND key=?",
          ).run(namespace, key)
        );
      },
      scan: (
        input: { prefix: string; after?: string; limit: number },
      ): { key: string; value: string }[] => {
        if (!Number.isSafeInteger(input.limit) || input.limit < 1) {
          throw new TypeError("Expected positive plugin scan limit");
        }
        const exclusive = input.after !== undefined &&
          compareKeys(input.after, input.prefix) >= 0;
        const lower = exclusive ? input.after! : input.prefix;
        const upper = prefixUpper(input.prefix);
        const parameters: (string | number)[] = [namespace, lower];
        if (upper !== undefined) parameters.push(upper);
        parameters.push(input.limit);
        return this.db.connection.prepare(
          `SELECT key,value FROM plugin_storage WHERE namespace=? AND key${
            exclusive ? ">" : ">="
          }?${upper !== undefined ? " AND key<?" : ""} ORDER BY key LIMIT ?`,
        ).all(...parameters).map((row) => ({
          key: String(row.key),
          value: String(row.value),
        }));
      },
      transaction: <T>(run: () => T): T =>
        this.db.write((scope) => {
          const before = transaction;
          transaction = scope;
          try {
            return run();
          } finally {
            transaction = before;
          }
        }, transaction),
    };
  }
}
