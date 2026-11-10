// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals } from "@std/assert";
import { DatabaseSync } from "node:sqlite";
import { metadata, type NativeSession } from "../metadata.ts";
import { mapSession } from "../map.ts";
import { V2NativeDb } from "../native-db.ts";
import { V2SessionLists } from "../session-lists.ts";
import { V2Client } from "../client.ts";

const raw = (id: string, idle: number, updated: number): NativeSession => ({
  id,
  title: id,
  projectID: "p",
  location: { directory: "/repo" },
  time: { created: 1, busy: idle - 1, idle, updated },
  cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
});
Deno.test("V2 metadata and content recency ignore generic metadata updates", () => {
  const session = raw("ses_old", 20, 1000);
  assertEquals(metadata(session).timeUpdated, 20);
  assertEquals(mapSession(session).time.updated, 20);
});

Deno.test("V2 SQL recency keysets and project activity use activity clocks, not metadata order", () => {
  const root = Deno.makeTempDirSync({ prefix: "v2-recency-" });
  const file = root + "/native.db", writer = new DatabaseSync(file);
  writer.exec(
    "CREATE TABLE project(id TEXT,worktree TEXT); INSERT INTO project VALUES('p','/repo'); CREATE TABLE session_v2(id TEXT,project_id TEXT,directory TEXT,parent_id TEXT,time_created INTEGER,time_updated INTEGER,time_busy INTEGER,time_idle INTEGER); CREATE TABLE session_message(id TEXT,session_id TEXT,type TEXT,seq INTEGER,time_created INTEGER,data TEXT);",
  );
  writer.exec(
    "INSERT INTO session_v2 VALUES('ses_old','p','/repo',NULL,1,1000,10,20),('ses_new','p','/repo',NULL,1,30,29,30),('ses_shell','p','/repo',NULL,1,900,NULL,NULL); INSERT INTO session_message VALUES('msg_shell','ses_shell','shell',1,40,'{\"time\":{\"created\":40,\"completed\":45}}'),('msg_control','ses_shell','agent-switched',2,900,'{}');",
  );
  const db = new V2NativeDb(file);
  try {
    const first = db.list({ directory: "/repo" }, undefined, 1);
    assertEquals(first.map((row) => [row.id, row.timeUpdated]), [[
      "opcv2-ses_shell",
      45,
    ]]);
    const rest = db.list({ directory: "/repo" }, {
      updated: first[0].timeUpdated,
      id: "ses_shell",
    }, 2);
    assertEquals(rest.map((row) => row.id), ["opcv2-ses_new", "opcv2-ses_old"]);
    assertEquals(db.projects("", 20)[0].lastActivity, 45);
  } finally {
    db.close();
    writer.close();
    Deno.removeSync(root, { recursive: true });
  }
});

Deno.test("V2 API activity keysets sort across native metadata-order pages without retaining bodies", async () => {
  const controller = new AbortController();
  const client = new V2Client(
    { endpoint: { url: "http://127.0.0.1:42" }, version: "2.2.6", pid: 42 },
    1000,
    controller.signal,
    (input) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (url.pathname.endsWith("/message")) {
        return Promise.resolve(Response.json({ data: [], cursor: {} }));
      }
      return Promise.resolve(Response.json(
        url.searchParams.has("cursor")
          ? { data: [raw("ses_active", 100, 100)], cursor: {} }
          : {
            data: [raw("ses_metadata", 20, 1000)],
            cursor: { next: "opaque-native" },
          },
      ));
    },
  );
  const lists = new V2SessionLists(), input = { directory: "/repo", limit: 1 };
  const first = await lists.read(input, client, undefined, controller.signal);
  assertEquals(first.items.map((row) => [row.id, row.timeUpdated]), [[
    "opcv2-ses_active",
    100,
  ]]);
  const second = await lists.read(
    { ...input, before: first.older! },
    client,
    undefined,
    controller.signal,
  );
  assertEquals(second.items.map((row) => row.id), ["opcv2-ses_metadata"]);
  assertEquals(second.older, null);
});
