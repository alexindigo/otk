// SPDX-License-Identifier: LGPL-3.0-only
import type { FeatureMigrations } from "./migrations.ts";
import { SqliteDb } from "./sqlite.ts";
declare const writeScope: unique symbol;
/** Opaque capability valid only during one synchronous OtkDb.write callback. */
export interface StoreWrite {
  readonly [writeScope]: true;
}

/** Disk-backed SQLite connection with caller-composed feature migrations. */
export class OtkDb extends SqliteDb {
  #scope?: StoreWrite;
  #publish: (() => void)[] = [];
  constructor(
    statePath: string,
    migrations: readonly FeatureMigrations[],
    options: { observerError?: (error: unknown) => void } = {},
  ) {
    super(statePath, "otk.db", migrations, { ...options, busyms: 5000 });
  }
  /** Join only an explicitly supplied scope; an omitted scope always starts a write. */
  write<T>(run: (tx: StoreWrite) => T, tx?: StoreWrite): T {
    if (tx !== undefined) {
      this.#validate(tx);
      return this.#sync(run, tx);
    }
    const scope = Object.freeze({}) as StoreWrite;
    const publish: (() => void)[] = [];
    const result = this.transaction(() => {
      this.#scope = scope;
      this.#publish = publish;
      try {
        return this.#sync(run, scope);
      } finally {
        this.#scope = undefined;
        this.#publish = [];
      }
    });
    for (const notify of publish) {
      try {
        notify();
      } catch (error) {
        try {
          this.observerError(error);
        } catch (reportError) {
          console.error(
            "Store observer reporting failed",
            new AggregateError([error, reportError]),
          );
        }
      }
    }
    return result;
  }
  afterCommit(tx: StoreWrite, publish: () => void): void {
    this.#validate(tx);
    this.#publish.push(publish);
  }
  #validate(tx: StoreWrite): void {
    if (this.#scope === undefined || tx !== this.#scope) {
      throw new Error("Invalid or expired store write scope");
    }
  }
  #sync<T>(run: (tx: StoreWrite) => T, tx: StoreWrite): T {
    const result = run(tx);
    if (
      result !== null &&
      (typeof result === "object" || typeof result === "function") &&
      "then" in result
    ) {
      throw new TypeError("Store writes must be synchronous");
    }
    return result;
  }
}
