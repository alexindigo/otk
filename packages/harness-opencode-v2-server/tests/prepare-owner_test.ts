// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals, assertRejects } from "@std/assert";
import { DatabaseSync } from "node:sqlite";
import { OpencodeV2DigestSink } from "../digest.ts";
import { opencodeV2DigestMigrations } from "../digest-migrations.ts";
import { cfg } from "../../../tests/support/config.ts";

Deno.test("V2 SQL reads reuse proven registration generations and reprove replacements", async () => {
  const root = await Deno.makeTempDir({ prefix: "v2-prepare-" });
  const db = new DatabaseSync(root + "/native.db");
  const store = new DatabaseSync(":memory:");
  for (const migration of opencodeV2DigestMigrations.migrations) {
    store.exec(await Deno.readTextFile(migration.sql));
  }
  db.exec(
    "CREATE TABLE project(id TEXT,worktree TEXT); INSERT INTO project VALUES('p','/repo'); CREATE TABLE session_v2(id TEXT,project_id TEXT,directory TEXT,parent_id TEXT,time_created INTEGER,time_updated INTEGER); INSERT INTO session_v2 VALUES('ses_one','p','/repo',NULL,1,1);",
  );
  db.exec(
    "CREATE TABLE session_message(id TEXT,session_id TEXT,type TEXT,seq INTEGER,time_created INTEGER,data TEXT); CREATE TABLE session_part(message_id TEXT,session_id TEXT,ordinal INTEGER,type TEXT,call_id TEXT,data TEXT);",
  );
  let infos = 0, projects = 0, gets = 0, pid = 42;
  const server = Deno.serve(
    { hostname: "127.0.0.1", port: 0, onListen() {} },
    (request) => {
      if (new URL(request.url).pathname === "/api/info") {
        infos++;
        return Response.json({ version: "2.2.6", pid });
      }
      if (new URL(request.url).pathname === "/api/session/ses_one") {
        gets++;
        return Response.json({
          data: {
            id: "ses_one",
            projectID: "p",
            location: { directory: "/repo" },
            time: { created: 1 },
            cost: 0,
            tokens: {
              input: 0,
              output: 0,
              reasoning: 0,
              cache: { read: 0, write: 0 },
            },
          },
        });
      }
      projects++;
      return Response.json([{ id: "p", canonical: "/repo" }]);
    },
  );
  const file = root + "/service.json";
  const register = () =>
    Deno.writeTextFile(
      file,
      JSON.stringify({
        url: `http://127.0.0.1:${server.addr.port}`,
        version: "2.2.6",
        pid,
      }),
    );
  const settings = cfg();
  const sink = new OpencodeV2DigestSink(
    {
      serviceFile: file,
      db: root + "/native.db",
      requestms: 1000,
      attachments: settings.attachments,
    },
    settings.digest,
    {
      sql: store,
      transaction: (run) => run(),
      read: () => undefined,
      turn: () => undefined,
      known: () => [],
      write() {},
      publish() {},
      diagnostic() {},
    },
  );
  const signal = new AbortController().signal;
  try {
    await register();
    await sink.identities(["opcv2-ses_one"], signal);
    const baseline = [infos, projects];
    for (let n = 0; n < 4; n++) {
      assertEquals(await sink.identities(["opcv2-ses_one"], signal), [{
        id: "opcv2-ses_one",
        directory: "/repo",
      }]);
    }
    assertEquals([infos, projects], baseline);
    const transcript = sink.readers["opcv2.transcript"]!;
    await transcript({ sessionID: "opcv2-ses_one", messages: [] }, signal);
    await transcript({ sessionID: "opcv2-ses_one", messages: [] }, signal);
    assertEquals(gets, 1);
    db.exec("UPDATE session_v2 SET time_updated=2");
    await transcript({ sessionID: "opcv2-ses_one", messages: [] }, signal);
    assertEquals(gets, 2);
    pid++;
    await register();
    await sink.identities(["opcv2-ses_one"], signal);
    assertEquals(projects, baseline[1] + 1);
    sink.connection(1);
    await sink.identities(["opcv2-ses_one"], signal);
    assertEquals(projects, baseline[1] + 2);
    await Deno.writeTextFile(file, "{");
    await assertRejects(() => sink.identities(["opcv2-ses_one"], signal));
  } finally {
    await sink.close();
    await server.shutdown();
    db.close();
    store.close();
    await Deno.remove(root, { recursive: true });
  }
});
