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

test("a rejected first digest commit leaves scan generation and baseline together", async () => {
  const root = await tempDir("checkpoint-"), file = join(root, "native.db");
  const native = new DatabaseSync(file), derived = new DatabaseSync(":memory:");
  native.exec(
    "CREATE TABLE session(id TEXT PRIMARY KEY,parent_id TEXT,directory TEXT,project_id TEXT,title TEXT,time_created INTEGER,time_updated INTEGER,time_archived INTEGER); CREATE TABLE message(id TEXT PRIMARY KEY,session_id TEXT,data TEXT); CREATE TABLE part(id TEXT PRIMARY KEY,message_id TEXT,session_id TEXT,data TEXT)",
  );
  for (const migration of opencodeV1DigestMigrations.migrations) {
    derived.exec(Deno.readTextFileSync(migration.sql));
  }
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
