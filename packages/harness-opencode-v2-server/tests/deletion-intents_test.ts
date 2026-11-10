// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals, assertRejects } from "@std/assert";
import { DatabaseSync } from "node:sqlite";
import type { SessionMetadata } from "@otk/protocol";
import type { DigestPublication } from "@otk/harness";
import { OpencodeV2DigestSink, type V2DigestStorage } from "../digest.ts";
import { opencodeV2DigestMigrations } from "../digest-migrations.ts";
import { cfg } from "../../../tests/support/config.ts";

Deno.test("V2 deletion intents persist, fence ownership/generations and classify event-before-response exactly once", async () => {
  const db = new DatabaseSync(":memory:"),
    publications: DigestPublication[] = [];
  try {
    for (const migration of opencodeV2DigestMigrations.migrations) {
      db.exec(await Deno.readTextFile(migration.sql));
    }
    db.exec("CREATE TABLE snapshots(id TEXT PRIMARY KEY, value TEXT NOT NULL)");
    const read: V2DigestStorage["read"] = (id) => {
      const row = db.prepare("SELECT value FROM snapshots WHERE id=?").get(id);
      return row ? JSON.parse(String(row.value)) : undefined;
    };
    const storage: V2DigestStorage = {
      sql: db,
      read,
      turn: () => undefined,
      known: () =>
        db.prepare("SELECT value FROM snapshots").all().map((r) =>
          JSON.parse(String(r.value))
        ),
      transaction: (run) => {
        db.exec("BEGIN");
        try {
          const value = run();
          db.exec("COMMIT");
          return value;
        } catch (error) {
          db.exec("ROLLBACK");
          throw error;
        }
      },
      write: (metadata, delta) => {
        db.prepare("INSERT OR REPLACE INTO snapshots VALUES (?,?)").run(
          metadata.id,
          JSON.stringify({
            metadata,
            summary: delta.summary,
            deleted: delta.deleted,
          }),
        );
      },
      publish: (value) => {
        publications.push(value);
      },
      diagnostic: (_id, error) => {
        throw error;
      },
    };
    const settings = cfg();
    const open = () =>
      new OpencodeV2DigestSink(
        {
          serviceFile: "/unused",
          db: "/unused",
          requestms: 1000,
          attachments: settings.attachments,
        },
        settings.digest,
        storage,
      );
    let sink = open();
    sink.connection(7);
    const entry = (suffix: string): SessionMetadata => ({
      id: `opcv2-ses_${suffix}`,
      directory: "/repo",
      projectID: "project",
      archived: false,
      title: suffix,
      timeCreated: 1,
      timeUpdated: 2,
      status: "idle",
      attention: {
        permissions: 0,
        questions: 0,
        childPermissions: 0,
        childQuestions: 0,
      },
    });
    const own = entry("owned");
    await sink.deleteIntent(own.id, "first", "begin", 7);
    await sink.deleted(7, own.id, 1, own);
    assertEquals(read(own.id)?.deleted?.how, "otk");
    const revision = read(own.id)!.summary.revision;
    await sink.deleted(7, own.id, 1, own);
    await sink.deleted(7, own.id, 2, own);
    assertEquals(
      read(own.id)!.summary.revision,
      revision,
      "duplicate deletion cannot replace its original fact",
    );
    await sink.deleteIntent(own.id, "first", "confirmed", 7);
    assertEquals(
      db.prepare(
        "SELECT confirmed FROM opcv2_delete_intents WHERE session_id=?",
      ).get(own.id)?.confirmed,
      1,
    );
    const external = entry("external");
    await sink.deleted(7, external.id, 1, external);
    assertEquals(read(external.id)?.deleted?.how, "provider");
    await sink.deleteIntent(external.id, "owned-late", "begin", 7);
    await sink.deleteIntent(external.id, "wrong", "confirmed", 7);
    assertEquals(read(external.id)?.deleted?.how, "provider");
    await sink.deleteIntent(external.id, "owned-late", "confirmed", 7);
    assertEquals(read(external.id)?.deleted?.how, "otk");
    const failed = entry("failed");
    await sink.deleteIntent(failed.id, "current", "begin", 7);
    await sink.deleteIntent(failed.id, "stale", "failed", 7);
    assertEquals(
      db.prepare(
        "SELECT intent_id FROM opcv2_delete_intents WHERE session_id=?",
      ).get(failed.id)?.intent_id,
      "current",
    );
    await sink.deleteIntent(failed.id, "current", "failed", 7);
    await sink.deleted(7, failed.id, 1, failed);
    assertEquals(read(failed.id)?.deleted?.how, "provider");
    const retained = entry("retained");
    await sink.deleteIntent(retained.id, "survives", "begin", 7);
    await sink.close();
    sink = open();
    sink.connection(7);
    await sink.deleted(7, retained.id, 1, retained);
    assertEquals(
      read(retained.id)?.deleted?.how,
      "otk",
      "same-generation worker restart retains durable intent",
    );
    sink.connection(8);
    await sink.deleteIntent("opcv2-ses_stale", "old", "begin", 7);
    await sink.deleted(7, "opcv2-ses_stale", 1, entry("stale"));
    assertEquals(read("opcv2-ses_stale"), undefined);
    const changed = entry("changed");
    await sink.deleted(8, changed.id, 1, changed);
    assertEquals(read(changed.id)?.deleted?.how, "provider");
    await assertRejects(
      () => sink.deleted(8, changed.id, 2, own),
      Error,
      "identity mismatch",
    );
    assertEquals(publications.filter((p) => p.sessionID === own.id).length, 1);
    await sink.close();
  } finally {
    db.close();
  }
});
