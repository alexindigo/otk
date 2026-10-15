// SPDX-License-Identifier: LGPL-3.0-only
import type { DatabaseSync } from "node:sqlite";

/** Frozen pre-feature schema bridge. Never used once the tracking table exists. */
export function legacyMigrations(
  db: DatabaseSync,
): readonly { feature: string; version: number }[] {
  const version = Number(db.prepare("PRAGMA user_version").get()!.user_version);
  switch (version) {
    case 0:
      return [];
    case 1:
      return [{ feature: "prefs", version: 1 }];
    case 2:
      return [
        { feature: "prefs", version: 1 },
        { feature: "frecency", version: 1 },
      ];
    default:
      throw new Error(
        `Unsupported legacy otk.db schema ${version}; expected 0, 1 or 2`,
      );
  }
}
