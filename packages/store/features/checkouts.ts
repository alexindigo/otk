// SPDX-License-Identifier: LGPL-3.0-only
import type { OtkDb } from "../db.ts";
import type { FeatureMigrations } from "../migrations.ts";

export const checkoutsMigrations: FeatureMigrations = {
  feature: "checkouts",
  migrations: [{
    version: 1,
    sql: new URL("./migrations/checkouts/001.sql", import.meta.url),
  }],
};
/** Durable native affiliation, not rebuildable digest data or user policy. */
export interface CheckoutRecord {
  source: string;
  repoID: string;
  scope: string;
  canonicalRoot: string;
  leafDirectory: string;
  kind: "checkout" | "worktree" | "unknown";
  availability: "present" | "removed" | "unknown";
  proven: boolean;
}
export class Checkouts {
  constructor(readonly db: OtkDb) {}
  list(): CheckoutRecord[] {
    return this.db.connection.prepare(
      "SELECT * FROM checkout_history ORDER BY source,repo,scope",
    ).all().map((row) => ({
      source: String(row.source),
      repoID: String(row.repo),
      scope: String(row.scope),
      canonicalRoot: String(row.canonical),
      leafDirectory: String(row.checkout),
      kind: row.kind as CheckoutRecord["kind"],
      availability: row.availability as CheckoutRecord["availability"],
      proven: !!row.proven,
    }));
  }
  save(records: readonly CheckoutRecord[]): void {
    this.db.write(() => {
      const statement = this.db.connection.prepare(
        "INSERT INTO checkout_history VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(source,repo,scope) DO UPDATE SET canonical=excluded.canonical,checkout=excluded.checkout,kind=excluded.kind,availability=excluded.availability,proven=excluded.proven",
      );
      for (const r of records) {
        statement.run(
          r.source,
          r.repoID,
          r.scope,
          r.canonicalRoot,
          r.leafDirectory,
          r.kind,
          r.availability,
          Number(r.proven),
        );
      }
    });
  }
}
