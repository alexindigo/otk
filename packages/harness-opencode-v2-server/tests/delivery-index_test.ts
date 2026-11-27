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

Deno.test("a delayed synthetic promotion cannot cover a successor execution", () => {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec(`CREATE TABLE session_v2(id TEXT PRIMARY KEY, parent_id TEXT);
      CREATE TABLE session_message(id TEXT PRIMARY KEY, session_id TEXT, seq INTEGER, type TEXT, time_created INTEGER, data TEXT);
      CREATE TABLE event(id TEXT PRIMARY KEY, aggregate_id TEXT, seq INTEGER, type TEXT, created INTEGER, data TEXT);
      INSERT INTO session_v2 VALUES ('parent',NULL),('child','parent');
      INSERT INTO session_message VALUES
        ('run-1','child',2,'idle',20,'{"outcome":"succeeded"}'),
        ('run-2','child',4,'idle',30,'{"outcome":"succeeded"}'),
        ('receipt-1','parent',5,'synthetic',40,'{"metadata":{"source":"subagent","childID":"child","state":"completed"}}');
      INSERT INTO event VALUES ('enqueue-1','parent',3,'session.inbox.enqueued',21,'{"inboxID":"receipt-1"}');`);
    assertEquals(scanDeliveries(db, "opcv2-parent", "", 10).updates, [{
      id: "opcv2-child",
      delivered: {
        parentID: "opcv2-parent",
        receipt: "receipt-1",
        terminal: 20,
        runID: "run-1",
      },
    }]);
  } finally {
    db.close();
  }
});

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
    const write = native.prepare(
      "INSERT INTO session_message VALUES (?,?,?,?,?,?)",
    );
    const message = (
      session: string,
      seq: number,
      type: string,
      at: number,
      data: unknown,
    ) =>
      write.run(
        `${session}-${seq}`,
        session,
        seq,
        type,
        at,
        JSON.stringify(data),
      );
    for (let seq = 1; seq <= 12; seq++) {
      message("parent", seq, "assistant", seq, {});
    }
    message("child", 1, "idle", 20, { outcome: "succeeded" });
    const report = (seq: number, at: number) =>
      message(
        "parent",
        seq,
        "synthetic",
        at,
        {
          metadata: {
            source: "subagent",
            childID: "child",
            state: "completed",
          },
        },
      );
    const parentID = "opcv2-parent", childID = "opcv2-child";
    let after: string | undefined;
    const step = (revision: number) => {
      // Recreate the worker adapter for each page to exercise durable progress.
      const index = new DeliveryIndex(
        digest,
        "opcv2_delivery",
        (run) => run(),
        4,
      );
      const page = index.step(
        { parentID, after },
        "source",
        revision,
        (cursor) => scanDeliveries(native, parentID, cursor, 4),
      );
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
    let completed = false;
    for (let revision = 101; revision <= 106; revision++) {
      const { index, page } = step(revision);
      assert(page.updates.length <= 4);
      found ||= index.facts([childID]).some(({ delivered }) =>
        delivered.receipt === "parent-15" && delivered.terminal === 40
      );
      if (found) {
        assertEquals<unknown>(index.facts([childID])[0].delivered, {
          parentID,
          receipt: "parent-15",
          terminal: 40,
          runID: "child-3",
        });
      }
      if (!after) {
        completed = true;
        break;
      }
    }
    assert(found, "a mutable parent revision cannot rewind a credited page");
    assert(completed, "a mutable revision cannot prevent the final replay");
  } finally {
    native.close();
    digest.close();
  }
});
