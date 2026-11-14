// SPDX-License-Identifier: LGPL-3.0-only
import type { DatabaseSync, StatementSync } from "node:sqlite";

/** Native read connections prepare each fixed SQL shape once per owner.
 * Unfinalized statements hold native memory the JS heap does not account for. */
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
