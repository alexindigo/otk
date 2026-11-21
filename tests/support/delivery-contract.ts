// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals } from "@std/assert";
import { DatabaseSync } from "node:sqlite";
import { DeliveryIndex, type DeliveryScan } from "@otk/harness";

const envelope = (state = "completed", child = "child") =>
  `<task id="${child}" state="${state}">\n<${
    state === "error" ? "task_error" : "task_result"
  }>\nResult body must not survive indexing\n</${
    state === "error" ? "task_error" : "task_result"
  }>\n</task>`;
const tool2 = (status = "completed", child = "child") => ({
  type: "tool",
  id: "call",
  name: "subagent",
  time: { created: 10, completed: 30 },
  state: {
    status: "completed",
    content: [{ type: "text", text: "Received helper result" }],
    metadata: { sessionID: child, status },
  },
});
const tool1 = (state = "completed", child = "child") => ({
  type: "tool",
  tool: "task",
  state: {
    status: "completed",
    output: envelope(state, child),
    metadata: { sessionId: child },
    time: { start: 10, end: 30 },
  },
});
export function deliveryContract(
  version: 1 | 2,
  scan: (
    db: Pick<DatabaseSync, "prepare">,
    parentID: string,
    cursor: string,
    limit: number,
  ) => DeliveryScan,
  migrations: { migrations: readonly { version: number; sql: URL }[] },
  decode: (
    raw: Record<string, unknown>,
    receipt: string,
    received: number,
  ) => { childID: string } | undefined,
) {
  Deno.test(`V${version} delivery codecs distinguish launch, received result, failure report and malformed identity`, () => {
    const tool = version === 1 ? tool1 : tool2;
    assertEquals(decode(tool(), "receipt", 40)?.childID, "child");
    assertEquals(decode(tool("running"), "receipt", 40), undefined);
    assertEquals(
      decode(tool("completed", "invalid/child"), "receipt", 40),
      undefined,
    );
    const failed = tool();
    failed.state.status = "error";
    assertEquals(decode(failed, "receipt", 40), undefined);
    const denied = tool();
    denied.state.status = "denied";
    assertEquals(decode(denied, "receipt", 40), undefined);
    assertEquals(
      decode(
        {
          type: "tool",
          tool: "task",
          name: "subagent",
          state: { status: "completed" },
        },
        "receipt",
        40,
      ),
      undefined,
    );
    if (version === 2) {
      for (const state of ["completed", "error", "cancelled"]) {
        assert(
          decode(
            {
              type: "synthetic",
              metadata: { source: "subagent", childID: "child", state },
            },
            "received",
            40,
          ),
        );
      }
      assertEquals(
        decode(
          {
            type: "synthetic",
            metadata: {
              source: "subagent",
              childID: "child",
              state: "running",
            },
          },
          "received",
          40,
        ),
        undefined,
      );
      assertEquals(
        decode(
          {
            type: "synthetic",
            metadata: {
              source: "subagent",
              childID: "child",
              state: "completed",
            },
          },
          "enqueued",
          0,
        ),
        undefined,
      );
    } else {
      for (const state of ["completed", "error"]) {
        assert(
          decode(
            { type: "text", synthetic: true, text: envelope(state) },
            "received",
            40,
          ),
        );
      }
      assertEquals(
        decode({ type: "text", text: envelope() }, "ordinary", 40),
        undefined,
      );
    }
  });

  const prefix = `opcv${version}`, parentID = `${prefix}-parent`;
  const fixture = () => {
    const native = new DatabaseSync(":memory:"),
      derived = new DatabaseSync(":memory:");
    if (version === 2) {
      native.exec(
        "CREATE TABLE session_v2(id TEXT PRIMARY KEY,parent_id TEXT,time_idle INTEGER); CREATE TABLE session_message(id TEXT PRIMARY KEY,session_id TEXT,seq INTEGER,type TEXT,time_created INTEGER,data TEXT); CREATE INDEX messages_session ON session_message(session_id,seq); CREATE TABLE session_part(session_id TEXT,message_id TEXT,ordinal INTEGER,type TEXT,data TEXT);",
      );
    } else {native.exec(
        "CREATE TABLE session(id TEXT PRIMARY KEY,parent_id TEXT); CREATE TABLE message(id TEXT PRIMARY KEY,session_id TEXT,time_created INTEGER,data TEXT); CREATE INDEX messages_session ON message(session_id,id); CREATE TABLE part(id TEXT PRIMARY KEY,session_id TEXT,message_id TEXT,data TEXT); CREATE INDEX parts_session ON part(session_id,id);",
      );}
    for (const migration of migrations.migrations) {
      derived.exec(Deno.readTextFileSync(migration.sql));
    }
    const add = (
      id: string,
      n: number,
      kind = "synthetic",
      state = "completed",
      terminal = 20,
    ) => {
      if (version === 2) {
        native.prepare("INSERT INTO session_v2 VALUES(?,?,?)").run(
          id,
          "parent",
          terminal,
        );
        native.prepare("INSERT INTO session_message VALUES(?,?,?,?,?,?)").run(
          `idle-${id}`,
          id,
          1,
          "idle",
          terminal,
          JSON.stringify({ outcome: "succeeded" }),
        );
        const synthetic = {
          type: "synthetic",
          metadata: { source: "subagent", childID: id, state },
        };
        const raw = tool2(state, id);
        native.prepare("INSERT INTO session_message VALUES(?,?,?,?,?,?)").run(
          `receipt-${id}`,
          "parent",
          n,
          kind === "synthetic" ? "synthetic" : "assistant",
          40,
          JSON.stringify(kind === "synthetic" ? synthetic : { content: [raw] }),
        );
      } else {
        native.prepare("INSERT INTO session VALUES(?,?)").run(id, "parent");
        native.prepare("INSERT INTO message VALUES(?,?,?,?)").run(
          `idle-${id}`,
          id,
          terminal - 1,
          JSON.stringify({
            role: "assistant",
            finish: "stop",
            time: { created: terminal - 1, completed: terminal },
          }),
        );
        native.prepare("INSERT INTO message VALUES(?,?,?,?)").run(
          `receipt-${id}`,
          "parent",
          40,
          JSON.stringify({ role: "user" }),
        );
        const raw = kind === "synthetic"
          ? { type: "text", synthetic: true, text: envelope(state, id) }
          : tool1(state, id);
        native.prepare("INSERT INTO part VALUES(?,?,?,?)").run(
          String(n).padStart(6, "0"),
          "parent",
          `receipt-${id}`,
          JSON.stringify(raw),
        );
      }
    };
    const index = () =>
      new DeliveryIndex(derived, `${prefix}_delivery`, (run) => {
        derived.exec("BEGIN");
        try {
          const value = run();
          derived.exec("COMMIT");
          return value;
        } catch (error) {
          derived.exec("ROLLBACK");
          throw error;
        }
      }, 16);
    return {
      native,
      derived,
      add,
      index,
      close: () => {
        native.close();
        derived.close();
      },
    };
  };
  Deno.test(`V${version} 120 historical helper receipts backfill bounded chunks and restart without parent rescans`, () => {
    const f = fixture();
    try {
      for (let n = 1; n <= 120; n++) f.add(`child${n}`, n);
      f.add("not-received", 121, "tool", "running");
      const facts = new Map();
      let scans = 0, after: string | undefined;
      // Stop halfway and replace the index object: durable coverage resumes.
      const first = f.index().step({ parentID }, "source", 1, (cursor) => {
        scans++;
        return scan(f.native, parentID, cursor, 16);
      });
      first.updates.forEach((r) => facts.set(r.id, r.delivered));
      after = first.after;
      do {
        const page = f.index().step(
          { parentID, after },
          "source",
          1,
          (cursor) => {
            scans++;
            return scan(f.native, parentID, cursor, 16);
          },
        );
        assert(page.updates.length <= 16);
        page.updates.forEach((r) => facts.set(r.id, r.delivered));
        after = page.after;
      } while (after !== undefined);
      assertEquals(facts.size, 120);
      assertEquals(scans, 8);
      assertEquals(facts.has(`${prefix}-not-received`), false);
      after = undefined;
      let replayed = 0;
      do {
        const page = f.index().step({ parentID, after }, "source", 1, () => {
          throw new Error("Covered parent was scanned after restart");
        });
        replayed += page.updates.length;
        after = page.after;
      } while (after !== undefined);
      assertEquals(replayed, 120);
      const rows = f.derived.prepare(`SELECT * FROM ${prefix}_delivery`).all();
      assertEquals(Object.keys(rows[0]).sort(), [
        "child_id",
        "parent_id",
        "receipt",
        "terminal",
      ]);
      assertEquals(JSON.stringify(rows).includes("Result body"), false);
      const reset = f.index().step(
        { parentID },
        "replacement-source",
        2,
        () => ({ updates: [], cursor: "", complete: true }),
      );
      assertEquals(reset.reset, true);
      assertEquals(
        f.derived.prepare(`SELECT count(*) AS n FROM ${prefix}_delivery`).get()
          ?.n,
        0,
      );
    } finally {
      f.close();
    }
  });
  Deno.test(`V${version} resumed children never borrow a newer run; exact foreground completion can acknowledge`, () => {
    const f = fixture();
    try {
      f.add("reused", 1);
      if (version === 2) {
        f.native.prepare("INSERT INTO session_message VALUES(?,?,?,?,?,?)").run(
          "idle-2",
          "reused",
          2,
          "idle",
          50,
          JSON.stringify({ outcome: "failed" }),
        );
        f.native.prepare("UPDATE session_v2 SET time_idle=50").run();
      } else {f.native.prepare("INSERT INTO message VALUES(?,?,?,?)").run(
          "idle-2",
          "reused",
          49,
          JSON.stringify({
            role: "assistant",
            error: { name: "Error" },
            time: { created: 49, completed: 50 },
          }),
        );}
      // The report covers the latest terminal at or before it; the newer
      // terminal is not covered and stays unseen.
      assertEquals(
        scan(f.native, parentID, "", 16).updates.map((r) => [
          r.id,
          r.delivered.terminal,
        ]),
        [[`${prefix}-reused`, 20]],
      );
      // A newer foreground invocation covers only the newer end.
      if (version === 2) {
        const raw = tool2("completed", "reused");
        raw.time = { created: 45, completed: 60 };
        f.native.prepare(
          "UPDATE session_message SET data=?,time_created=60 WHERE id='receipt-reused'",
        ).run(JSON.stringify({ content: [raw] }));
      } else {
        const raw = tool1("completed", "reused");
        raw.state.time = { start: 45, end: 60 };
        f.native.prepare("UPDATE part SET data=?").run(JSON.stringify(raw));
      }
      const result = scan(f.native, parentID, "", 16).updates;
      assertEquals(result.length, 1);
      assertEquals(result[0].delivered.terminal, 50);
    } finally {
      f.close();
    }
  });
  const terminalAt = (
    f: ReturnType<typeof fixture>,
    id: string,
    terminal: number,
    key: string,
  ) => {
    if (version === 2) {
      f.native.prepare("INSERT INTO session_message VALUES(?,?,?,?,?,?)").run(
        `idle-${key}`,
        id,
        2,
        "idle",
        terminal,
        JSON.stringify({ outcome: "succeeded" }),
      );
      f.native.prepare(
        "UPDATE session_v2 SET time_idle=max(time_idle,?) WHERE id=?",
      ).run(terminal, id);
    } else {
      f.native.prepare("INSERT INTO message VALUES(?,?,?,?)").run(
        `idle-${key}`,
        id,
        terminal - 1,
        JSON.stringify({
          role: "assistant",
          finish: "stop",
          time: { created: terminal - 1, completed: terminal },
        }),
      );
    }
  };
  Deno.test(`V${version} a report after several runs acknowledges the latest terminal before it; equal clocks stay ambiguous`, () => {
    const f = fixture();
    try {
      f.add("multi", 1);
      terminalAt(f, "multi", 30, "multi-2");
      assertEquals(
        scan(f.native, parentID, "", 16).updates.map((r) => [
          r.id,
          r.delivered.terminal,
        ]),
        [[`${prefix}-multi`, 30]],
      );
      f.add("tied", 2, "synthetic", "completed", 30);
      terminalAt(f, "tied", 30, "tied-2");
      assertEquals(
        scan(f.native, parentID, "", 16).updates.map((r) => r.id),
        [`${prefix}-multi`],
      );
    } finally {
      f.close();
    }
  });
  Deno.test(`V${version} a parent refresh keeps covered facts; only source replacement retires them`, () => {
    const f = fixture();
    try {
      f.add("kept", 1);
      const step = (source: string, revision: number, refresh = false) =>
        f.index().step(
          { parentID, refresh },
          source,
          revision,
          (cursor) => scan(f.native, parentID, cursor, 16),
        );
      assertEquals(step("source", 1).updates.length, 1);
      const count = () =>
        f.derived.prepare(`SELECT count(*) AS n FROM ${prefix}_delivery`).get()
          ?.n;
      f.native.exec(
        version === 2
          ? "DELETE FROM session_message WHERE id='receipt-kept'"
          : "DELETE FROM part",
      );
      assertEquals(step("source", 2, true).reset, true);
      assertEquals(count(), 1);
      assertEquals(
        f.index().facts([`${prefix}-kept`]).map((r) => r.delivered.terminal),
        [20],
      );
      step("replacement", 3);
      assertEquals(count(), 0);
      assertEquals(f.index().facts([`${prefix}-kept`]), []);
    } finally {
      f.close();
    }
  });
}
