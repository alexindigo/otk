// SPDX-License-Identifier: LGPL-3.0-only
import { DatabaseSync, type StatementSync } from "node:sqlite";
import { join } from "@std/path";
import { transaction } from "./transaction.ts";
import {
  processStorage,
  type StorageAvailability,
  type StorageConnection,
  StorageFailure,
  storageProblem,
} from "./availability.ts";
import {
  type FeatureMigrations,
  migrate,
  validateMigrations,
} from "./migrations.ts";

export interface SqliteOptions {
  /** Zero is fail-fast: an external cooperative owner waits/retries lock readiness. */
  busyms: number;
  observerError?: (error: unknown) => void;
  /** The application owns diagnostic level and transport; stdout is a protocol. */
  diagnostic?: (message: string) => void;
  availability?: StorageAvailability;
}
/** Bounded LRU of fixed SQL shapes. Unfinalized statements hold native memory
 * the JS heap does not account for, so each shape is prepared once per owner. */
export function cachedStatements(db: DatabaseSync, limit = 256): DatabaseSync {
  const statements = new Map<string, StatementSync>();
  // Resolve the class method per call; instance replacements wrap this cache.
  const native = (...args: unknown[]): StatementSync =>
    Reflect.apply(Object.getPrototypeOf(db).prepare, db, args);
  const prepare = (sql: string, ...options: unknown[]): StatementSync => {
    if (options.length) return native(sql, ...options);
    let statement = statements.get(sql);
    if (statement) statements.delete(sql);
    else {
      statement = native(sql);
      if (statements.size >= limit) {
        statements.delete(statements.keys().next().value!);
      }
    }
    statements.set(sql, statement);
    return statement;
  };
  return new Proxy(db, {
    get(target, key) {
      // An instance-level replacement (an observer) wraps this cache.
      if (key === "prepare" && !Object.hasOwn(target, key)) return prepare;
      if (key === "close") {
        return () => {
          statements.clear();
          target.close();
        };
      }
      const value = Reflect.get(target, key, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}
/** Connection mechanics only. Feature composition belongs to the caller. */
export class SqliteDb {
  readonly connection: DatabaseSync;
  readonly observerError: (error: unknown) => void;
  readonly availability: StorageAvailability;
  readonly #probeWrite: () => void;
  readonly #storage: StorageConnection;
  constructor(
    statePath: string,
    filename: string,
    migrations: readonly FeatureMigrations[],
    options: SqliteOptions,
  ) {
    if (statePath === "") throw new TypeError("State path must not be empty");
    if (!/^[a-zA-Z0-9_-]+\.db$/.test(filename)) {
      throw new TypeError("Invalid database filename");
    }
    if (!Number.isSafeInteger(options.busyms) || options.busyms < 0) {
      throw new TypeError("Invalid SQLite busy timeout");
    }
    validateMigrations(migrations);
    this.observerError = options.observerError ??
      ((error) => console.error("Store observer failed after commit", error));
    const path = join(statePath, filename);
    this.availability = options.availability ?? processStorage;
    const owner = this.availability;
    const guard = <T>(operation: string, run: () => T): T => {
      try {
        return run();
      } catch (cause) {
        const problem = storageProblem(cause);
        if (!problem) throw cause;
        const error = cause instanceof StorageFailure
          ? cause
          : new StorageFailure(problem, path, operation, cause);
        if (this.#storage) this.#storage.failed(error);
        else owner.failed(error);
        throw error;
      }
    };
    guard(
      "directory",
      () => Deno.mkdirSync(statePath, { recursive: true, mode: 0o700 }),
    );
    const raw = guard("open", () => new DatabaseSync(path));
    const cached = cachedStatements(raw);
    const statements = new WeakMap<StatementSync, StatementSync>();
    const db = this.connection = new Proxy(cached, {
      get(target, key) {
        if (key === "prepare") {
          const prepare = target.prepare;
          return (sql: string, ...args: unknown[]) =>
            guard("prepare", () => {
              const statement: StatementSync = Reflect.apply(prepare, target, [
                sql,
                ...args,
              ]);
              let wrapped = statements.get(statement);
              if (!wrapped) {
                wrapped = new Proxy(statement, {
                  get(statement, method) {
                    const value = Reflect.get(statement, method, statement);
                    if (typeof value !== "function") return value;
                    return (...args: unknown[]) =>
                      guard(`statement.${String(method)}`, () => {
                        const result = Reflect.apply(value, statement, args);
                        // Iterator stepping can fail after prepare/iterate returned.
                        if (method !== "iterate") return result;
                        const iterator = result as IterableIterator<unknown>;
                        const watched: IterableIterator<unknown> = new Proxy(
                          iterator,
                          {
                            get(target, key) {
                              if (key === Symbol.iterator) return () => watched;
                              const value = Reflect.get(target, key, target);
                              return typeof value === "function"
                                ? (...args: unknown[]) =>
                                  guard(
                                    `statement.iterator.${String(key)}`,
                                    () => Reflect.apply(value, target, args),
                                  )
                                : value;
                            },
                          },
                        );
                        return watched;
                      });
                  },
                });
                statements.set(statement, wrapped);
              }
              return wrapped;
            });
        }
        const value = Reflect.get(target, key, target);
        return typeof value === "function"
          ? (...args: unknown[]) =>
            guard(String(key), () => Reflect.apply(value, target, args))
          : value;
      },
    });
    try {
      guard("permissions", () => Deno.chmodSync(path, 0o600));
      // Install the lock wait before WAL selection (concurrent first open).
      db.exec(
        `PRAGMA busy_timeout=${options.busyms}; PRAGMA journal_mode=WAL; PRAGMA mmap_size=0; PRAGMA foreign_keys=ON`,
      );
      migrate(db, migrations);
      // A real committed page, not SELECT/free-space estimates, proves recovery.
      this.#probeWrite = () =>
        transaction(db, () => {
          db.exec(
            "CREATE TABLE IF NOT EXISTS otk_storage_probe(id INTEGER PRIMARY KEY CHECK(id=1), value BLOB NOT NULL)",
          );
          db.exec(
            "INSERT OR REPLACE INTO otk_storage_probe VALUES(1, randomblob(4096))",
          );
        });
      logSettings(db, options.diagnostic);
      this.#storage = owner.register(path, this.#probeWrite);
    } catch (error) {
      try {
        db.close();
      } catch (cleanup) {
        throw new AggregateError(
          [error, cleanup],
          "SQLite startup and cleanup failed",
          { cause: error },
        );
      }
      throw error;
    }
  }
  transaction<T>(run: () => T): T {
    const failure = this.#storage.failure();
    if (failure) throw failure;
    return transaction(this.connection, run);
  }
  /** An explicit replacement owner must prove a commit, not merely reopen. */
  probe(): void {
    this.#probeWrite();
    this.#storage.recovered();
  }
  close(): void {
    try {
      this.connection.close();
    } finally {
      this.#storage.close();
    }
  }
}

let settingsLogged = false;
function logSettings(
  db: DatabaseSync,
  diagnostic?: (message: string) => void,
): void {
  if (settingsLogged || !diagnostic) return;
  diagnostic(`SQLite settings ${
    JSON.stringify({
      version: db.prepare("SELECT sqlite_version() AS version").get()!.version,
      mmap_size: db.prepare("PRAGMA mmap_size").get()!.mmap_size,
    })
  }`);
  settingsLogged = true;
}
