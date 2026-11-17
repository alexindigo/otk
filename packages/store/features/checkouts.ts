// SPDX-License-Identifier: LGPL-3.0-only
import type { OtkDb } from "../db.ts";
import type { FeatureMigrations } from "../migrations.ts";

export const checkoutsMigrations: FeatureMigrations = {
  feature: "checkouts",
  migrations: [{
    version: 1,
    sql: new URL("./migrations/checkouts/001.sql", import.meta.url),
  }, {
    version: 2,
    sql: new URL("./migrations/checkouts/002.sql", import.meta.url),
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
export interface CheckoutAuthority {
  sources: readonly string[];
  scopes: readonly {
    source: string;
    scope: string;
    owners: readonly string[];
  }[];
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
  authority(): CheckoutAuthority | undefined {
    const row = this.db.connection.prepare(
      "SELECT sources FROM checkout_authority WHERE id=1",
    ).get();
    if (!row) return;
    const scopes = new Map<
      string,
      { source: string; scope: string; owners: string[] }
    >();
    for (
      const row of this.db.connection.prepare(
        "SELECT source,scope,repo FROM checkout_scope_owners ORDER BY source,scope,repo",
      ).all()
    ) {
      const source = String(row.source),
        scope = String(row.scope),
        key = JSON.stringify([source, scope]);
      const group = scopes.get(key) ?? { source, scope, owners: [] };
      group.owners.push(String(row.repo));
      scopes.set(key, group);
    }
    return {
      sources: JSON.parse(String(row.sources)),
      scopes: [...scopes.values()],
    };
  }
  /** Changed complete scope sets and active sources commit with their history rows. */
  save(
    records: readonly CheckoutRecord[],
    authority?: CheckoutAuthority,
  ): void {
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
      if (authority) {
        this.db.connection.prepare(
          "INSERT INTO checkout_authority VALUES(1,?) ON CONFLICT(id) DO UPDATE SET sources=excluded.sources",
        ).run(JSON.stringify(authority.sources));
        const remove = this.db.connection.prepare(
          "DELETE FROM checkout_scope_owners WHERE source=? AND scope=?",
        );
        const insert = this.db.connection.prepare(
          "INSERT INTO checkout_scope_owners VALUES(?,?,?)",
        );
        for (const { source, scope, owners } of authority.scopes) {
          remove.run(source, scope);
          for (const repo of owners) insert.run(source, scope, repo);
        }
      }
    });
  }
}
