// SPDX-License-Identifier: LGPL-3.0-only
import type { OtkDb } from "../db.ts";
import type { FeatureMigrations } from "../migrations.ts";

/** The prefs feature contributes its original schema version, independently. */
export const prefsMigrations: FeatureMigrations = {
  feature: "prefs",
  migrations: [
    { version: 1, sql: new URL("./migrations/prefs/001.sql", import.meta.url) },
  ],
};

/** Application policy; storage owns neither preference keys nor error types. */
export interface PrefsOptions<P extends object> {
  readonly defaults: Readonly<P>;
  readonly validate: (
    key: unknown,
    value: unknown,
  ) => key is Extract<keyof P, string>;
  readonly invalid: () => Error;
}

/** JSON preference persistence, validated reads/writes and change subscriptions. */
export class Prefs<P extends object> {
  #listeners = new Set<(prefs: P) => void>();
  constructor(readonly db: OtkDb, readonly options: PrefsOptions<P>) {}
  get(): P {
    const prefs = { ...this.options.defaults };
    for (
      const row of this.db.connection.prepare("SELECT key, value FROM prefs")
        .all()
    ) {
      const value: unknown = JSON.parse(String(row.value));
      if (this.options.validate(row.key, value)) {
        Object.assign(prefs, { [row.key]: value });
      }
    }
    return prefs;
  }
  set(key: unknown, value: unknown): P {
    if (!this.options.validate(key, value)) {
      throw this.options.invalid();
    }
    this.db.connection.prepare(
      "INSERT INTO prefs(key,value,updated) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated=excluded.updated",
    ).run(key, JSON.stringify(value), Date.now());
    const prefs = this.get();
    for (const listener of this.#listeners) listener(prefs);
    return prefs;
  }
  listen(listener: (prefs: P) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }
}
