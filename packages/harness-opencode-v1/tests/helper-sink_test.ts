// SPDX-License-Identifier: LGPL-3.0-only
import { derivedValue } from "@otk/protocol";
import { assert, assertEquals } from "@std/assert";
import { DatabaseSync } from "node:sqlite";
import { join } from "@std/path";
import {
  DigestNativeDb,
  type DigestSnapshot,
  type Info,
  opencodeV1DigestMigrations,
  OpencodeV1DigestSink,
  type RawPart,
} from "@otk/harness-opencode-v1";
import { tempDir, test } from "../../../tests/support/resources.ts";
import { cfg } from "../../../tests/support/config.ts";
const policy = {
  batch: 50,
  slicems: 8,
  cpu: 1,
  memoryreserve: 1,
  maxpending: 128,
  idlems: 1,
  parallel: 3,
  background: false,
  publishrows: 50,
  retryms: 10,
  busyms: 100,
};
for (const api of [false, true]) {
  test(`helper ${api ? "API" : "SQL"} digest counts600, orders labels, removes tools, reports honest clocks and commits atomically`, async () => {
    const root = await tempDir("helper-sink-");
    const path = join(root, "native.db"),
      native = new DatabaseSync(path),
      derived = new DatabaseSync(":memory:");
    native.exec(
      "CREATE TABLE session(id TEXT PRIMARY KEY,parent_id TEXT,directory TEXT,project_id TEXT,title TEXT,time_created INTEGER,time_updated INTEGER,time_archived INTEGER); CREATE TABLE message(id TEXT PRIMARY KEY,session_id TEXT,data TEXT); CREATE TABLE part(id TEXT PRIMARY KEY,message_id TEXT,session_id TEXT,data TEXT); INSERT INTO session VALUES('child','parent','/p','p','Child',1,2,NULL)",
    );
    for (const migration of opencodeV1DigestMigrations.migrations) {
      derived.exec(Deno.readTextFileSync(migration.sql));
    }
    native.exec(
      "ALTER TABLE message ADD COLUMN time_created INTEGER GENERATED ALWAYS AS (json_extract(data,'$.time.created')) VIRTUAL; CREATE INDEX message_order ON message(session_id,time_created,id)",
    );
    const messages: { info: Info; parts: RawPart[] }[] = [];
    native.exec("BEGIN");
    for (let i = 0; i <= 1200; i++) {
      const id = `m${String(i).padStart(4, "0")}`;
      const info: Info = {
        id,
        agent: "build",
        sessionID: "child",
        role: i === 0 ? "user" : "assistant",
        parentID: "m0000",
        time: { created: i, ...(i ? { completed: i + 1 } : {}) },
      };
      const parts: RawPart[] = i % 2
        ? [{
          id: `p${String(i).padStart(4, "0")}`,
          sessionID: "child",
          messageID: id,
          type: "tool",
          tool: "bash",
          state: {
            status: "completed",
            title: `Tool ${i}`,
            time: { start: i, end: i + 1 },
            input: { secret: "do not persist input" },
            output: "do not persist output",
          },
        }]
        : [];
      messages.push({ info, parts });
      native.prepare("INSERT INTO message VALUES(?,'child',?)").run(
        id,
        JSON.stringify(info),
      );
      for (const part of parts) {
        native.prepare("INSERT INTO part VALUES(?,?,'child',?)").run(
          part.id,
          id,
          JSON.stringify(part),
        );
      }
    }
    native.exec("COMMIT");
    const values = new Map<string, DigestSnapshot>();
    let fail = false, queries = 0, apiReads = 0;
    const sink = new OpencodeV1DigestSink(
      {
        harness: {
          url: "http://fixture",
          db: api ? join(root, "absent") : path,
          username: "",
          password: "",
          heartbeattimeout: 25,
          reconnectmax: 30,
          requestms: 60000,
        },
        index: { days: 30 },
        attachments: cfg().attachments,
      },
      policy,
      {
        sql: derived,
        read: (id) => values.get(id),
        known: () => values.values(),
        turn: () => undefined,
        transaction(run) {
          const saved = structuredClone(values);
          derived.exec("BEGIN");
          try {
            const value = run();
            derived.exec("COMMIT");
            return value;
          } catch (e) {
            derived.exec("ROLLBACK");
            values.clear();
            for (const [id, value] of saved) values.set(id, value);
            throw e;
          }
        },
        write(metadata, delta) {
          if (fail) {
            fail = false;
            throw new Error("reject commit");
          }
          values.set(metadata.id, {
            metadata,
            summary: delta.summary,
            deleted: delta.deleted,
            helper: delta.helper === undefined
              ? values.get(metadata.id)?.helper
              : delta.helper ?? undefined,
          });
        },
        publish: () => {},
        diagnostic: () => {},
      },
      ((input: string | URL | Request) => {
        const url = new URL(String(input));
        if (url.pathname === "/global/health") {
          return Promise.resolve(Response.json({ healthy: true }));
        }
        if (url.pathname === "/experimental/session") {
          return Promise.resolve(
            Response.json([{
              id: "child",
              parentID: "parent",
              projectID: "p",
              directory: "/p",
              title: "Child",
              time: { created: 1, updated: 2 },
            }]),
          );
        }
        assertEquals(url.pathname, "/session/child/message");
        apiReads++;
        const limit = Number(url.searchParams.get("limit"));
        assert(limit > 0 && limit <= policy.batch);
        const end = Number(url.searchParams.get("before") ?? messages.length),
          start = Math.max(0, end - limit);
        return Promise.resolve(
          Response.json(messages.slice(start, end), {
            headers: start ? { "x-next-cursor": String(start) } : {},
          }),
        );
      }) as typeof fetch,
      (file) =>
        new DigestNativeDb(file, (operation) => {
          if (operation === "helpers") queries++;
        }),
    );
    const signal = new AbortController().signal;
    const scan = async (targets?: string[]) => {
      let cursor: string | undefined, steps = 0;
      do {
        cursor = await sink.step(
          {
            provider: sink.identity,
            sessionID: "opcv1-child",
            updated: 2,
            revision: 1,
            projection: "helper",
            messages: targets,
            cursor,
          },
          { rows: policy.batch, until: performance.now() + 8 },
          signal,
        );
        assert(++steps < 150);
      } while (cursor);
      return values.get("opcv1-child")!.helper!;
    };
    try {
      await sink.catalog(signal);
      sink.invalidateHelper("opcv1-child");
      let helper = await scan();
      assertEquals(derivedValue(helper.progress)!.toolCount, 600);
      assertEquals(derivedValue(helper.progress)!.current, {
        name: "bash",
        title: "Tool 1199",
        startedAt: 1199,
      });
      assertEquals(derivedValue(helper.progress)!.time, {
        start: 0,
        end: 1201,
      });
      assertEquals(helper.state, "ready");
      assert(
        !JSON.stringify(
          derived.prepare("SELECT * FROM opcv1_helper_tools").all(),
        ).includes("do not persist"),
      );
      // Independent helper cursors no longer exhaust headers before tools.
      if (api) {
        assertEquals(apiReads, Math.ceil(messages.length / policy.batch));
      } else assert(queries >= 12 && queries < 16);
      // Duplicate scans never double-count, and stale rows survive a rejected commit.
      sink.invalidateHelper("opcv1-child");
      fail = true;
      try {
        await scan();
        throw new Error("expected commit rejection");
      } catch (e) {
        assertEquals((e as Error).message, "reject commit");
      }
      assertEquals(
        Number(
          derived.prepare("SELECT count(*) n FROM opcv1_helper_tools").get()!.n,
        ),
        600,
      );
      helper = await scan();
      assertEquals(derivedValue(helper.progress)!.toolCount, 600);
      native.prepare("DELETE FROM part WHERE id='p1199'").run();
      messages[1199].parts = [];
      sink.invalidateHelper("opcv1-child");
      const beforeRemoval = queries;
      helper = await scan(["m1199"]);
      assertEquals(derivedValue(helper.progress)!.toolCount, 599);
      assertEquals(derivedValue(helper.progress)!.current?.title, "Tool 1197");
      if (!api) {
        assert(
          queries - beforeRemoval <= 2,
          "A live helper edit must not rescan unrelated tools",
        );
      }
      // Unfinished source has no fabricated end.
      const info = messages[1200].info;
      delete info.time.completed;
      native.prepare("UPDATE message SET data=? WHERE id=?").run(
        JSON.stringify(info),
        info.id,
      );
      sink.invalidate("opcv1-child", 2);
      sink.invalidateHelper("opcv1-child");
      helper = await scan();
      assertEquals(derivedValue(helper.progress)!.time, { start: 0 });
      if (!api) {
        const retained = structuredClone(helper.progress);
        native.prepare("UPDATE part SET data='invalid' WHERE id='p0001'").run();
        sink.invalidateHelper("opcv1-child");
        helper = await scan();
        assertEquals(helper.state, "unavailable");
        assertEquals(helper.progress, retained);
      }
    } finally {
      sink.close();
      native.close();
      derived.close();
    }
  });
}
