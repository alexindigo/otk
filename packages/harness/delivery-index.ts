// SPDX-License-Identifier: LGPL-3.0-only
import type { DatabaseSync } from "node:sqlite";
import type { DeliveryPage, DeliveryScan } from "./provider-reads.ts";
/** Rebuildable scalar machinery, borrowed by each plugin's private namespace.
 * Native classifications and correlation are supplied by that plugin. */
export class DeliveryIndex {
  constructor(
    readonly sql: Pick<DatabaseSync, "prepare">,
    readonly table: string,
    readonly transaction: <T>(run: () => T) => T,
    readonly limit: number,
  ) {
    if (!/^[a-z][a-z0-9_]*$/.test(table)) {
      throw new TypeError("Invalid delivery namespace");
    }
  }
  step(
    input: { parentID: string; after?: string; refresh?: boolean },
    source: string,
    revision: number,
    scan: (cursor: string) => DeliveryScan,
  ): DeliveryPage {
    const table = this.table;
    const stored = this.sql.prepare(
      `SELECT * FROM ${table}_scan WHERE parent_id=?`,
    ).get(input.parentID);
    // A credited scan owns its cursor until it reaches the tail. The parent's
    // mutable revision is an invalidation for the next pass, not a generation
    // change for the active pass. Otherwise a busy parent can starve discovery
    // even though every requested page has successfully run.
    const reset = !stored || stored.source !== source || !!stored.complete &&
      (stored.revision !== revision || input.refresh && input.after === undefined);
    const cursor = reset ? "" : String(stored.cursor);
    if (reset || !stored.complete) {
      const page = scan(cursor);
      this.transaction(() => {
        if (stored && stored.source !== source) {
          this.sql.prepare(`DELETE FROM ${table} WHERE parent_id=?`).run(
            input.parentID,
          );
        }
        for (const { id, delivered } of page.updates) {
          this.sql.prepare(
            `INSERT INTO ${table}(parent_id,receipt,child_id,terminal) VALUES(?,?,?,?) ON CONFLICT(parent_id,receipt) DO UPDATE SET child_id=excluded.child_id,terminal=max(terminal,excluded.terminal)`,
          ).run(input.parentID, delivered.receipt, id, delivered.terminal);
        }
        this.sql.prepare(
          `INSERT INTO ${table}_scan(parent_id,source,revision,cursor,complete) VALUES(?,?,?,?,?) ON CONFLICT(parent_id) DO UPDATE SET source=excluded.source,revision=excluded.revision,cursor=excluded.cursor,complete=excluded.complete`,
        ).run(
          input.parentID,
          source,
          reset ? revision : stored.revision,
          page.cursor,
          Number(page.complete),
        );
      });
      return { updates: page.updates, reset: !!reset, after: "scan" };
    }
    const rows = this.sql.prepare(
      `SELECT child_id,max(terminal) AS terminal,receipt FROM ${table} WHERE parent_id=? AND child_id>? GROUP BY child_id ORDER BY child_id LIMIT ?`,
    ).all(
      input.parentID,
      input.after === "scan" ? "" : input.after ?? "",
      this.limit,
    );
    return {
      updates: rows.map((row) => ({
        id: String(row.child_id),
        delivered: {
          parentID: input.parentID,
          receipt: String(row.receipt),
          terminal: Number(row.terminal),
        },
      })),
      ...(rows.length === this.limit
        ? { after: String(rows.at(-1)!.child_id) }
        : {}),
    };
  }
  /** Indexed child/run join, independent of native connection availability. */
  facts(
    ids: readonly string[],
  ): import("./provider-reads.ts").DeliveryScalar[] {
    if (!ids.length) return [];
    return this.sql.prepare(
      `SELECT child_id,parent_id,receipt,max(terminal) AS terminal FROM ${this.table} WHERE child_id IN (SELECT value FROM json_each(?)) GROUP BY child_id`,
    ).all(JSON.stringify(ids)).map((row) => ({
      id: String(row.child_id),
      delivered: {
        parentID: String(row.parent_id),
        receipt: String(row.receipt),
        terminal: Number(row.terminal),
      },
    }));
  }
  retire(id: string): void {
    this.transaction(() => {
      this.sql.prepare(`DELETE FROM ${this.table} WHERE parent_id=?`).run(id);
      this.sql.prepare(`DELETE FROM ${this.table} WHERE child_id=?`).run(id);
      this.sql.prepare(`DELETE FROM ${this.table}_scan WHERE parent_id=?`).run(
        id,
      );
    });
  }
}
