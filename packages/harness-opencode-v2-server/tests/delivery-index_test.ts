// SPDX-License-Identifier: LGPL-3.0-only
import { deliveryContract } from "../../../tests/support/delivery-contract.ts";
import { deliveryReceipt, scanDeliveries } from "../delivery.ts";
import { opencodeV2DigestMigrations } from "../digest-migrations.ts";
import { assert, assertEquals } from "@std/assert";
import { DatabaseSync } from "node:sqlite";
import { DeliveryIndex } from "@otk/harness";
deliveryContract(
  2,
  scanDeliveries,
  opencodeV2DigestMigrations,
  deliveryReceipt,
);

Deno.test("V2 receipt coverage advances across changing parent revisions and sidecar restart", () => {
  const native = new DatabaseSync(":memory:");
  const digest = new DatabaseSync(":memory:");
  try {
    for (const migration of opencodeV2DigestMigrations.migrations) {
      digest.exec(Deno.readTextFileSync(migration.sql));
    }
    native.exec(`CREATE TABLE session_v2(id TEXT PRIMARY KEY, parent_id TEXT);
      CREATE TABLE session_message(id TEXT PRIMARY KEY, session_id TEXT, seq INTEGER, type TEXT, time_created INTEGER, data TEXT);
      CREATE UNIQUE INDEX message_seq ON session_message(session_id, seq);
      CREATE TABLE session_part(session_id TEXT,message_id TEXT,ordinal INTEGER,type TEXT,data TEXT);
      INSERT INTO session_v2 VALUES ('parent',NULL),('child','parent');`);
    const write = native.prepare("INSERT INTO session_message VALUES (?,?,?,?,?,?)");
    const message = (session: string, seq: number, type: string, at: number, data: unknown) =>
      write.run(`${session}-${seq}`, session, seq, type, at, JSON.stringify(data));
    for (let seq = 1; seq <= 12; seq++) message("parent", seq, "assistant", seq, {});
    message("child", 1, "idle", 20, { outcome: "succeeded" });
    const report = (seq: number, at: number) => message(
      "parent", seq, "synthetic", at,
      { metadata: { source: "subagent", childID: "child", state: "completed" } },
    );
    const parentID = "opcv2-parent", childID = "opcv2-child";
    let after: string | undefined;
    const step = (revision: number) => {
      // Recreate the worker adapter for each page to exercise durable progress.
      const index = new DeliveryIndex(digest, "opcv2_delivery", (run) => run(), 4);
      const page = index.step({ parentID, after }, "source", revision,
        (cursor) => scanDeliveries(native, parentID, cursor, 4));
      after = page.after;
      return { page, index };
    };
    assertEquals(step(100).page.updates, []);
    report(13, 21);
    message("child", 2, "idle", 30, { outcome: "succeeded" });
    report(14, 31);
    message("child", 3, "idle", 40, { outcome: "succeeded" });
    report(15, 41);
    let found = false;
    for (let revision = 101; revision <= 106; revision++) {
      const { index, page } = step(revision);
      assert(page.updates.length <= 4);
      found ||= index.facts([childID]).some(({ delivered }) =>
        delivered.receipt === "parent-15" && delivered.terminal === 40
      );
      if (found) break;
    }
    assert(found, "a mutable parent revision cannot rewind a credited page");
  } finally {
    native.close();
    digest.close();
  }
});
