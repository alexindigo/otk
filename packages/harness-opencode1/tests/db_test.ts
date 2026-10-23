// SPDX-License-Identifier: LGPL-3.0-only
import { tempDir, test } from "../../../tests/support/resources.ts";
import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import { DatabaseSync } from "node:sqlite";
import { BootstrapDb } from "../db.ts";
import { usage } from "../usage.ts";
import { Client } from "../client.ts";
import { Messages } from "../messages.ts";
import { sessionDirectory } from "../directory.ts";
import { mapPart } from "../map.ts";
import { usageTool } from "@otk/protocol";

async function fixture(): Promise<string> {
  return join(await tempDir("native-db-"), "opencode.db");
}

test("bootstrap DB selects only recent incomplete/pending directories and leaves the database unchanged", async () => {
  const file = await fixture(), db = new DatabaseSync(file);
  db.exec(
    "CREATE TABLE session (id TEXT PRIMARY KEY, directory TEXT, time_updated INTEGER); CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, data TEXT)",
  );
  const session = db.prepare("INSERT INTO session VALUES (?, ?, ?)");
  const message = db.prepare("INSERT INTO message VALUES (?, ?, ?)");
  for (
    const [id, updated] of [["busy", 100], ["pending", 100], ["idle", 100], [
      "old",
      10,
    ], ["empty", 100]] as const
  ) session.run(id, "/" + id, updated);
  const put = (
    id: string,
    sessionID: string,
    role: string,
    completed?: number,
  ) =>
    message.run(
      id,
      sessionID,
      JSON.stringify({ role, time: { created: 1, completed } }),
    );
  put("msg_busy_1", "busy", "assistant");
  put("msg_pending_1", "pending", "user");
  put("msg_idle_1", "idle", "assistant");
  put("msg_idle_2", "idle", "assistant", 100);
  put("msg_old_1", "old", "assistant");
  db.close();
  const before = await Deno.readFile(file);
  const reader = new BootstrapDb(file);
  try {
    assertEquals(reader.possiblyRunningDirectories(50)?.sort(), [
      "/busy",
      "/pending",
    ]);
  } finally {
    reader.close();
  }
  assertEquals(await Deno.readFile(file), before);
});

test("bootstrap DB degrades on missing schema without creating a missing database", async () => {
  const missing = await fixture(), reader = new BootstrapDb(missing);
  assertEquals(reader.possiblyRunningDirectories(0), undefined);
  reader.close();
  try {
    await Deno.stat(missing);
    assert(false, "Read-only bootstrap created a database");
  } catch (error) {
    assert(error instanceof Deno.errors.NotFound);
  }
  const file = await fixture(), incomplete = new DatabaseSync(file);
  incomplete.exec("CREATE TABLE session (id TEXT)");
  incomplete.close();
  const degraded = new BootstrapDb(file);
  assertEquals(degraded.possiblyRunningDirectories(0), undefined);
  degraded.close();
});

test("bootstrap DB distinguishes an authoritative empty hint set from a failed query", async () => {
  const file = await fixture(), db = new DatabaseSync(file);
  db.exec(
    "CREATE TABLE session(id TEXT,directory TEXT,time_updated INTEGER); CREATE TABLE message(id TEXT,session_id TEXT,data TEXT)",
  );
  const reader = new BootstrapDb(file);
  try {
    assertEquals(reader.possiblyRunningDirectories(0), []);
    db.exec(
      "INSERT INTO session VALUES('s','/project',100); INSERT INTO message VALUES('m','s','not JSON')",
    );
    const before = await Deno.readFile(file);
    assertEquals(reader.possiblyRunningDirectories(0), undefined);
    assertEquals(await Deno.readFile(file), before);
  } finally {
    reader.close();
    db.close();
  }
});

test("usage reads every bounded metadata page and tool labels without content or writes; API fallback produces the same full summaries", async () => {
  const file = await fixture(), db = new DatabaseSync(file);
  db.exec(
    "CREATE TABLE session(id TEXT,directory TEXT,time_updated INTEGER); CREATE TABLE message(id TEXT,session_id TEXT,data TEXT); CREATE TABLE part(id TEXT,session_id TEXT,message_id TEXT,data TEXT)",
  );
  const rows = Array.from({ length: 103 }, (_, i) => ({
    info: {
      id: `m${String(i).padStart(3, "0")}`,
      sessionID: "s",
      role: "assistant",
      parentID: i < 102 ? "user" : "next",
      agent: "build",
      providerID: i % 2 ? "two" : "one",
      modelID: "same",
      time: { created: i * 1000, completed: i * 1000 + 500 },
      tokens: {
        input: 1,
        output: 2,
        reasoning: 3,
        cache: { read: 4, write: 5 },
        total: 15,
      },
      cost: .01,
      private: "secret-content",
    },
    parts: [
      {
        id: `tool-${i}`,
        sessionID: "s",
        messageID: `m${String(i).padStart(3, "0")}`,
        type: "tool",
        tool: "glob",
        state: {
          status: "completed",
          title: "Find source files",
          input: { pattern: "secret-input" },
          output: "secret-output",
        },
      },
      { type: "text", text: "secret-content" },
    ],
  }));
  const put = db.prepare("INSERT INTO message VALUES(?,?,?)");
  const putPart = db.prepare("INSERT INTO part VALUES(?,?,?,?)");
  for (const row of rows) {
    put.run(row.info.id, "s", JSON.stringify(row.info));
    const part = row.parts[0];
    putPart.run(part.id!, "s", row.info.id, JSON.stringify(part));
  }
  db.close();
  const before = await Deno.readFile(file),
    reader = new BootstrapDb(file),
    missing = new BootstrapDb(`${file}.missing`);
  const calls: number[] = [];
  const client = new Client({
    url: "http://native.invalid",
    username: "opencode",
    password: "",
    db: "",
    heartbeattimeout: 25,
    reconnectmax: 30,
  }, (input) => {
    const url = new URL(String(input)),
      limit = Number(url.searchParams.get("limit"));
    calls.push(limit);
    const start = Number(url.searchParams.get("before") ?? 0),
      items = rows.slice(start, start + limit);
    return Promise.resolve(
      Response.json(items, {
        headers: start + limit < rows.length
          ? { "x-next-cursor": String(start + limit) }
          : {},
      }),
    );
  });
  const messages = new Messages(client, () => "/project"),
    directory = sessionDirectory(() => "/project", () => {
      throw new Error("cached directory expected");
    });
  try {
    const sql = await usage(reader, messages, directory).getUsage("s");
    assertEquals(calls, []);
    assertEquals(sql.turns.user.tokens.input, 102);
    assertEquals(sql.total.tokens.cache.write, 515);
    assert(!JSON.stringify(sql).includes("secret-content"));
    assert(!JSON.stringify(sql).includes("secret-input"));
    assert(!JSON.stringify(sql).includes("secret-output"));
    assertEquals(sql.turns.user.time, { start: 0, end: 101500 });
    assertEquals(sql.messages[0].tools, [{
      id: "tool-0",
      name: "glob",
      summary: "Find source files",
    }]);
    const live = mapPart({
      id: "tool-0",
      sessionID: "s",
      messageID: "m000",
      type: "tool",
      tool: "glob",
      callID: "call",
      state: {
        status: "completed",
        title: "Find source files",
        input: { pattern: "**/*" },
      },
    });
    assert(live.kind === "tool" && live.call.tool === "search");
    assertEquals(
      usageTool(live),
      sql.messages[0].tools![0],
      "Normalized live kinds retain exactly the SQL/API source labels",
    );
    assert(!JSON.stringify(sql).includes('"total":15'));
    const fallback = await usage(missing, messages, directory).getUsage("s");
    assertEquals(calls, [100, 100]);
    assertEquals(fallback, sql);
  } finally {
    reader.close();
    missing.close();
  }
  assertEquals(await Deno.readFile(file), before);
});
