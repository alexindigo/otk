// SPDX-License-Identifier: LGPL-3.0-only
import type { DatabaseSync } from "node:sqlite";

/** Synchronous connection boundary. Features publish only after this returns. */
export function transaction<T>(db: DatabaseSync, run: () => T): T {
  // A failed/nested BEGIN must never roll back a transaction owned by its caller.
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = run();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch (rollback) {
      throw new AggregateError(
        [error, rollback],
        "Transaction and rollback failed",
        { cause: error },
      );
    }
    throw error;
  }
}
