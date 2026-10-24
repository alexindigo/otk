// SPDX-License-Identifier: LGPL-3.0-only
import { tempDir, test } from "../../../tests/support/resources.ts";
import { assert, assertEquals, assertRejects } from "@std/assert";
import { join } from "@std/path";
import { DatabaseSync } from "node:sqlite";
import { Opencode1Adapter } from "../adapter.ts";
import type { Info, RawPart, Session } from "../types.ts";
import { Messages } from "../messages.ts";
import { Client } from "../client.ts";
import { BootstrapDb } from "../db.ts";
import { requireCapability } from "@otk/harness";

for (const mode of ["SQL", "API"] as const) {
  test(`large reverted sessions and task cards use bounded ${mode} reads without changing their metadata`, async () => {
    const db = join(await tempDir("native-history-"), "missing.db");
    const session: Session = {
      id: "parent",
      projectID: "project",
      directory: "/project",
      title: "Parent",
      time: { created: 1, updated: 2000 },
      revert: { messageID: "msg_000500" },
    };
    const messages = Array.from({ length: 1201 }, (_, i) => ({
      info: {
        id: `msg_${String(i).padStart(6, "0")}`,
        sessionID: "child",
        role: i % 2 ? "assistant" : "user",
        agent: "general",
        time: { created: i, ...(i % 2 ? { completed: i + 1 } : {}) },
      } as Info,
      parts: i % 2
        ? [{
          id: `part_${i}`,
          messageID: `msg_${String(i).padStart(6, "0")}`,
          sessionID: "child",
          type: "tool",
          tool: "bash",
          state: {
            status: i === 1199 ? "pending" : "completed",
            input: {},
            title: `Tool ${i}`,
            output: "Large child output ".repeat(1000),
            time: { start: 1, end: i + 1 },
          },
        } as RawPart]
        : [],
    }));
    const task: RawPart = {
      id: "task",
      sessionID: "parent",
      messageID: "first",
      type: "tool",
      tool: "task",
      state: {
        status: "completed",
        input: { description: "Inspection", subagent_type: "general" },
        metadata: { sessionId: "child" },
        time: { start: 0, end: 1 },
      },
    };
    if (mode === "SQL") {
      // The stock 1.18.34 schema, not a hand-written approximation.
      await Deno.copyFile(
        new URL(
          "../../../tests/fixtures/opencode1/history-1.18.34-v4.db",
          import.meta.url,
        ),
        db,
      );
      const writer = new DatabaseSync(db);
      writer.exec("BEGIN");
      const clone = writer.prepare(
        "INSERT INTO session (id,project_id,slug,directory,title,version,time_created,time_updated) SELECT ?,project_id,?,directory,?,version,time_created,time_updated FROM session LIMIT 1",
      );
      for (const id of ["parent", "child"]) clone.run(id, id, id);
      const message = writer.prepare(
        "INSERT INTO message (id,session_id,time_created,time_updated,data) VALUES (?,?,?,?,?)",
      );
      const part = writer.prepare(
        "INSERT INTO part (id,message_id,session_id,time_created,time_updated,data) VALUES (?,?,?,?,?,?)",
      );
      for (const item of messages) {
        message.run(
          item.info.id,
          "parent",
          item.info.time.created,
          1,
          JSON.stringify(item.info),
        );
        const childID = `child_${item.info.id}`;
        message.run(
          childID,
          "child",
          item.info.time.created,
          1,
          JSON.stringify(item.info),
        );
        for (const raw of item.parts) {
          part.run(raw.id, childID, "child", 1, 1, JSON.stringify(raw));
        }
      }
      writer.exec("COMMIT");
      writer.close();
      const reader = new BootstrapDb(db);
      const prepare = DatabaseSync.prototype.prepare;
      let pages = 0;
      try {
        DatabaseSync.prototype.prepare = function (this: DatabaseSync, sql) {
          const statement = prepare.call(this, sql);
          const all = statement.all.bind(statement);
          statement.all = (...params) => {
            const rows: ReturnType<typeof all> = Reflect.apply(
              all,
              statement,
              params,
            );
            assert(
              sql.includes("LIMIT 100"),
              "Metadata row reads must have a SQL bound",
            );
            assert(
              rows.length <= 100,
              `Oversized SQL metadata page: ${rows.length}`,
            );
            pages++;
            return rows;
          };
          return statement;
        };
        const projected = [...reader.taskMessages("child")!];
        assert(!JSON.stringify(projected).includes("Large child output"));
        assertEquals(projected.filter((item) => item.parts.length).length, 600);
        assert(pages > 20, "Large histories must span bounded SQL reads");
      } finally {
        DatabaseSync.prototype.prepare = prepare;
        reader.close();
      }
    }
    const beforeDb = mode === "SQL" ? await Deno.readFile(db) : undefined;
    const reads: URL[] = [];
    const fetcher: typeof fetch = (input) => {
      const url = new URL(String(input));
      reads.push(url);
      if (url.pathname === "/session/parent") {
        return Promise.resolve(Response.json(session));
      }
      if (url.pathname === "/agent") return Promise.resolve(Response.json([]));
      assert(
        /\/session\/(parent|child)\/message$/.test(url.pathname),
        url.pathname,
      );
      const limit = Number(url.searchParams.get("limit"));
      assert(
        Number.isInteger(limit) && limit > 0 && limit <= 200,
        `Unbounded read: ${url}`,
      );
      if (mode === "SQL") {
        assertEquals(
          limit,
          1,
          "SQL metadata must not fetch histories over HTTP",
        );
      }
      if (
        url.pathname === "/session/parent/message" &&
        !url.searchParams.has("before") && limit === 1
      ) {
        return Promise.resolve(
          Response.json([{
            info: { ...messages[0].info, id: "first", sessionID: "parent" },
            parts: [task],
          }]),
        );
      }
      const end = Number(url.searchParams.get("before") ?? messages.length);
      const start = Math.max(0, end - limit);
      return Promise.resolve(Response.json(messages.slice(start, end), {
        headers: start ? { "x-next-cursor": String(start) } : {},
      }));
    };
    const adapter = new Opencode1Adapter(
      {
        harness: {
          url: "http://fixture",
          username: "opencode",
          password: "",
          db,
          heartbeattimeout: 25,
          reconnectmax: 30,
        },
        index: { days: 30 },
      },
      undefined,
      fetcher,
    );
    try {
      assertEquals(
        (await adapter.core.getSession("parent")).revert?.messageCount,
        351,
      );
      // Directory resolution for native @-agent completion must not fetch transcript content.
      const before = reads.length;
      await requireCapability(adapter.capabilities, "agents").listAgents(
        "parent",
      );
      assertEquals(reads.slice(before).map((url) => url.pathname), [
        "/session/parent",
        "/agent",
      ]);
      delete session.revert;
      const result = await adapter.core.listMessages("parent", { limit: 1 });
      const part = result[0].parts[0];
      assert(part.kind === "tool" && part.call.tool === "task");
      assertEquals(part.call.toolCount, 600);
      assertEquals(part.call.currentTool, "bash Tool 1197");
      assertEquals(part.call.duration, 1200);
      assert(!JSON.stringify(result).includes("Large child output"));
      assertEquals(
        reads.filter((url) => url.pathname === "/session/child/message").length,
        mode === "SQL" ? 0 : 13,
      );
    } finally {
      await adapter.core.stop();
    }
    if (beforeDb) assertEquals(await Deno.readFile(db), beforeDb);
  });
}

test("message collection owner rejects stock's unbounded limit values and stalled cursors", async () => {
  let calls = 0;
  const client = new Client({
    url: "http://fixture",
    username: "",
    password: "",
    db: "",
    heartbeattimeout: 25,
    reconnectmax: 30,
  }, () => {
    calls++;
    return Promise.resolve(
      Response.json([{ info: {}, parts: [] }], {
        headers: { "x-next-cursor": "same" },
      }),
    );
  });
  const messages = new Messages(client, () => undefined);
  for (const limit of [0, -1, NaN, Infinity, 0.5, 201, undefined]) {
    await assertRejects(
      () => messages.page("session", limit as number),
      Error,
      "limit must be 1..200",
    );
  }
  assertEquals(calls, 0);
  await assertRejects(
    () => messages.page("session", 100, "same"),
    Error,
    "pagination did not advance",
  );
  assertEquals(calls, 1);
});
