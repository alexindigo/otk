// SPDX-License-Identifier: LGPL-3.0-only
import { assert } from "@std/assert";
import { DatabaseSync } from "node:sqlite";
import { opencodeV2DigestMigrations } from "../digest-migrations.ts";

Deno.test("V2 readiness SQL on OTK-owned tables searches one session, never the population", async () => {
  const store = new DatabaseSync(":memory:");
  try {
    for (const migration of opencodeV2DigestMigrations.migrations) {
      store.exec(await Deno.readTextFile(migration.sql));
    }
    const source = await Deno.readTextFile(
      new URL("../digest.ts", import.meta.url),
    );
    // Fixed statement shapes only; templated shapes are composed elsewhere.
    const statements = [
      ...source.matchAll(/\.prepare\(\s*"((?:[^"\\]|\\.)*)"/g),
    ].map((match) => JSON.parse(`"${match[1]}"`) as string)
      .filter((sql) => /\bopcv2_(?:transcript|pending)/.test(sql));
    assert(statements.length >= 20, `found ${statements.length}`);
    for (const sql of statements) {
      const plan = store.prepare(`EXPLAIN QUERY PLAN ${sql}`).all()
        .map((row) => String(row.detail)).join("\n");
      assert(
        !/\bSCAN\b/.test(plan.replace(/SCAN json_each[^\n]*/g, "")),
        `${sql}\n${plan}`,
      );
      // Any ordering is bounded by one session's rows.
      if (plan) assert(/session_id=\?/.test(plan), `${sql}\n${plan}`);
    }
  } finally {
    store.close();
  }
});
