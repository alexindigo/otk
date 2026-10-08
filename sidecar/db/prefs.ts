// SPDX-License-Identifier: LGPL-3.0-only
import {
  DEFAULT_PREFS,
  isPreference,
  type Preferences,
} from "../../protocol/prefs.ts";
import { HarnessError } from "../adapter/types.ts";
import type { OtkDb } from "./db.ts";
export class Prefs {
  #listeners = new Set<(prefs: Preferences) => void>();
  constructor(readonly db: OtkDb) {}
  get(): Preferences {
    const prefs = { ...DEFAULT_PREFS };
    for (
      const row of this.db.connection.prepare("SELECT key, value FROM prefs")
        .all()
    ) {
      const value: unknown = JSON.parse(String(row.value));
      if (isPreference(row.key, value)) {
        Object.assign(prefs, { [row.key]: value });
      }
    }
    return prefs;
  }
  set(key: unknown, value: unknown): Preferences {
    if (!isPreference(key, value)) {
      throw new HarnessError("params", "Invalid preference key or value");
    }
    this.db.connection.prepare(
      "INSERT INTO prefs(key,value,updated) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated=excluded.updated",
    ).run(key, JSON.stringify(value), Date.now());
    const prefs = this.get();
    for (const listener of this.#listeners) listener(prefs);
    return prefs;
  }
  listen(listener: (prefs: Preferences) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }
}
