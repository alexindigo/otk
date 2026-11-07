// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals, assertRejects } from "@std/assert";
import { DatabaseSync } from "node:sqlite";
import { join } from "@std/path";
import {
  DigestNativeDb,
  opencodeV1DigestMigrations,
  OpencodeV1DigestSink,
} from "@otk/harness-opencode-v1";
import { tempDir, test } from "../../../tests/support/resources.ts";
import { cfg } from "../../../tests/support/config.ts";

test("migration 003 restarts existing ascending checkpoints and retains real baseline totals", () => {
  const db = new DatabaseSync(":memory:");
  try {
    for (
      const migration of opencodeV1DigestMigrations.migrations.filter((m) =>
        m.version < 3
      )
    ) db.exec(Deno.readTextFileSync(migration.sql));
    db.exec(
      "INSERT INTO opcv1_scan VALUES('opcv1-ses_old','ses_old','msg_ascending',7,12,12,0)",
    );
    db.exec(
      "INSERT INTO opcv1_messages(session_id,message_id,role,hash,scan_generation,time_created,cost,input,output,reasoning,cache_read,cache_write) VALUES('opcv1-ses_old','msg_old','assistant','retained',7,10,1.25,30,4,0,2,0)",
    );
    db.exec(
      "INSERT INTO opcv1_aggregates VALUES('opcv1-ses_old','',1,1,1.25,30,4,0,2,0,0,0,0,0,0,0)",
    );
    const messages = db.prepare("SELECT * FROM opcv1_messages").all();
    const totals = db.prepare("SELECT * FROM opcv1_aggregates").all();
    db.exec(
      Deno.readTextFileSync(
        opencodeV1DigestMigrations.migrations.find((m) => m.version === 3)!.sql,
      ),
    );
    assertEquals(
      db.prepare(
        "SELECT after_message,after_created,api_cursor,scan_generation,observed_revision,complete_revision,dirty,cursor_version FROM opcv1_scan",
      ).get(),
      {
        after_message: null,
        after_created: null,
        api_cursor: null,
        scan_generation: 8,
        observed_revision: 12,
        complete_revision: null,
        dirty: 1,
        cursor_version: 2,
      },
    );
    assertEquals(db.prepare("SELECT * FROM opcv1_messages").all(), messages);
    assertEquals(db.prepare("SELECT * FROM opcv1_aggregates").all(), totals);
  } finally {
    db.close();
  }
});

test("a rejected first digest commit leaves scan generation and baseline together", async () => {
  const root = await tempDir("checkpoint-"), file = join(root, "native.db");
  const native = new DatabaseSync(file), derived = new DatabaseSync(":memory:");
  native.exec(
    "CREATE TABLE session(id TEXT PRIMARY KEY,parent_id TEXT,directory TEXT,project_id TEXT,title TEXT,time_created INTEGER,time_updated INTEGER,time_archived INTEGER); CREATE TABLE message(id TEXT PRIMARY KEY,session_id TEXT,data TEXT); CREATE TABLE part(id TEXT PRIMARY KEY,message_id TEXT,session_id TEXT,data TEXT)",
  );
  for (const migration of opencodeV1DigestMigrations.migrations) {
    // Match the source collection clock used by descending checkpoints.
    derived.exec(Deno.readTextFileSync(migration.sql));
  }
  native.exec(
    "ALTER TABLE message ADD COLUMN time_created INTEGER GENERATED ALWAYS AS (json_extract(data,'$.time.created')) VIRTUAL; CREATE INDEX message_order ON message(session_id,time_created,id)",
  );
  native.exec(
    "INSERT INTO session VALUES('ses_one',NULL,'/p','p','One',1,2,NULL)",
  );
  native.prepare("INSERT INTO message VALUES('msg_one','ses_one',?)").run(
    JSON.stringify({ role: "user", time: { created: 1 } }),
  );
  let rejectWrite = false, headerReads = 0;
  class CountedNative extends DigestNativeDb {
    override headers(...args: Parameters<DigestNativeDb["headers"]>) {
      headerReads++;
      return super.headers(...args);
    }
  }
  const sink = new OpencodeV1DigestSink(
    {
      harness: {
        url: "http://fixture",
        db: file,
        username: "",
        password: "",
        heartbeattimeout: 25,
        reconnectmax: 30,
        requestms: 60000,
      },
      index: { days: 30 },
      attachments: cfg().attachments,
    },
    {
      batch: 100,
      slicems: 8,
      cpu: .25,
      memoryreserve: 1,
      maxpending: 512,
      idlems: 1,
      parallel: 3,
      background: false,
      publishrows: 64,
      retryms: 1000,
      busyms: 100,
    },
    {
      sql: derived,
      read: () => ({
        metadata: {
          id: "opcv1-ses_one",
          directory: "/p",
          projectID: "p",
          title: "One",
          timeCreated: 1,
          timeUpdated: 2,
          archived: false,
          status: "idle",
          attention: {
            permissions: 0,
            questions: 0,
            childPermissions: 0,
            childQuestions: 0,
          },
        },
        summary: { state: "digesting", revision: 0 },
        deleted: null,
      }),
      turn: () => undefined,
      known: () => [],
      transaction(run) {
        derived.exec("BEGIN");
        try {
          const result = run();
          derived.exec("COMMIT");
          return result;
        } catch (error) {
          derived.exec("ROLLBACK");
          throw error;
        }
      },
      write: () => {
        if (rejectWrite) throw new Error("rejected summary commit");
      },
      publish: () => {},
      diagnostic: () => {},
    },
    ((url) => {
      const path = new URL(String(url)).pathname;
      if (path === "/global/health") {
        return Promise.resolve(
          Response.json({ healthy: true }),
        );
      }
      if (path === "/experimental/session") {
        return Promise.resolve(
          Response.json([{
            id: "ses_one",
            projectID: "p",
            directory: "/p",
            title: "One",
            time: { created: 1, updated: 2 },
          }]),
        );
      }
      throw new Error(`Unexpected checkpoint fixture request: ${path}`);
    }) as typeof fetch,
    (file) => new CountedNative(file),
  );
  try {
    await sink.catalog(new AbortController().signal);
    rejectWrite = true;
    sink.invalidate("opcv1-ses_one", 1);
    const before = derived.prepare("SELECT * FROM opcv1_scan").all();
    await assertRejects(
      () =>
        sink.step(
          {
            provider: sink.identity,
            sessionID: "opcv1-ses_one",
            updated: 2,
            revision: 1,
          },
          { rows: 100, until: performance.now() + 8 },
          new AbortController().signal,
        ),
      Error,
      "rejected summary commit",
    );
    assertEquals(derived.prepare("SELECT * FROM opcv1_scan").all(), before);
    assertEquals(derived.prepare("SELECT * FROM opcv1_messages").all(), []);
    assertEquals(
      headerReads,
      1,
      "The rejected commit must follow a real native scalar read, not an earlier fallback error",
    );
  } finally {
    sink.close();
    native.close();
    derived.close();
  }
});
