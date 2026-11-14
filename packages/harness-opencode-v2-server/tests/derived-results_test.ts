// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals } from "@std/assert";
import { DatabaseSync } from "node:sqlite";
import { derivedValue, type DigestDelta } from "@otk/protocol";
import {
  OpencodeV2TranscriptDigestSink,
  type V2DigestStorage,
} from "../digest.ts";
import { opencodeV2DigestMigrations } from "../digest-migrations.ts";
import { V2NativeDb } from "../native-db.ts";
import type { V2Client } from "../client.ts";
import { cfg } from "../../../tests/support/config.ts";
import { DigestScheduler } from "@otk/harness";

const id = "opcv2-ses_one";
const zero = {
  input: 0,
  output: 0,
  reasoning: 0,
  cache: { read: 0, write: 0 },
};
async function fixture(disk = false) {
  const root = await Deno.makeTempDir({ prefix: "derived-v2-" });
  const db = new DatabaseSync(root + "/native.db"),
    sql = new DatabaseSync(disk ? root + "/digest.db" : ":memory:");
  if (disk) sql.exec("PRAGMA journal_mode=WAL");
  db.exec(
    "CREATE TABLE project(id TEXT,worktree TEXT); INSERT INTO project VALUES('p','/repo'); CREATE TABLE session_v2(id TEXT PRIMARY KEY,project_id TEXT,directory TEXT,parent_id TEXT,time_created INTEGER,time_updated INTEGER); INSERT INTO session_v2 VALUES('ses_one','p','/repo',NULL,1,1); CREATE TABLE session_message(id TEXT PRIMARY KEY,session_id TEXT,type TEXT,seq INTEGER,time_created INTEGER,data TEXT); CREATE INDEX message_order ON session_message(session_id,seq); CREATE TABLE session_part(message_id TEXT,session_id TEXT,ordinal INTEGER,type TEXT,call_id TEXT,data TEXT)",
  );
  for (const m of opencodeV2DigestMigrations.migrations) {
    sql.exec(await Deno.readTextFile(m.sql));
  }
  const native = new V2NativeDb(root + "/native.db");
  const records = new Map<
    string,
    NonNullable<ReturnType<V2DigestStorage["read"]>>
  >();
  const turns: DigestDelta["turns"]["upsert"] = {},
    publications: DigestDelta[] = [];
  const raw = {
    id: "ses_one",
    projectID: "p",
    location: { directory: "/repo" },
    time: { created: 1, updated: 100, busy: 1, idle: 100 },
    cost: 9,
    tokens: zero,
  };
  const client = {
    service: { pid: 1 },
    read: <T>(run: (api: unknown) => Promise<T>) =>
      run({
        session: {
          get: ({ sessionID }: { sessionID: string }) =>
            Promise.resolve({ ...raw, id: sessionID }),
        },
      }),
  } as unknown as V2Client;
  const sink = new OpencodeV2TranscriptDigestSink(
    cfg().digest,
    {
      sql,
      transaction: (run) => {
        sql.exec("BEGIN");
        try {
          const result = run();
          sql.exec("COMMIT");
          return result;
        } catch (error) {
          sql.exec("ROLLBACK");
          throw error;
        }
      },
      read: (key) => records.get(key),
      turn: (_id, turn) => turns[turn],
      known: () => [],
      write: (metadata, delta) => {
        records.set(metadata.id, {
          metadata,
          summary: delta.summary,
          deleted: delta.deleted,
          helper: delta.helper ?? records.get(metadata.id)?.helper,
        });
        Object.assign(turns, delta.turns.upsert);
        for (const turn of delta.turns.remove) delete turns[turn];
      },
      publish: ({ delta }) => {
        publications.push(structuredClone(delta));
      },
      diagnostic(_id, error) {
        throw error;
      },
    },
    {},
    {
      prepare: () => Promise.resolve({ client, native }),
      native: () => native,
      check: (signal) => signal.throwIfAborted(),
    },
  );
  const seed = (
    key: string,
    seq: number,
    type: string,
    data: Record<string, unknown> = {},
  ) =>
    db.prepare(
      "INSERT OR REPLACE INTO session_message VALUES(?,'ses_one',?,?,?,?)",
    ).run(
      key,
      type,
      seq,
      seq,
      JSON.stringify({
        time: { created: seq, completed: seq + 1 },
        model: { providerID: "p", id: "m" },
        ...data,
      }),
    );
  const step = (messages?: string[]) =>
    sink.step(
      {
        sessionID: id,
        provider: sink.identity,
        revision: 0,
        updated: 100,
        messages,
      },
      { rows: 2, until: Infinity },
      new AbortController().signal,
    );
  const scan = async (messages?: string[]) => {
    let slices = 0;
    while (await step(messages)) {
      if (++slices > 50) throw new Error("scan did not converge");
    }
  };
  return {
    sink,
    sql,
    db,
    seed,
    step,
    scan,
    turns,
    publications,
    records,
    saved: () => records.get(id),
    close: async () => {
      sink.close();
      native.close();
      db.close();
      sql.close();
      await Deno.remove(root, { recursive: true });
    },
  };
}

Deno.test("V2 retains covered results while rebuilding and retires removed turns after the sweep", async () => {
  const f = await fixture();
  try {
    f.seed("u", 1, "user");
    for (let n = 2; n < 7; n++) {
      f.seed(`a${n}`, n, "assistant", { cost: 1, tokens: zero });
    }
    f.seed("idle", 7, "idle");
    await f.step();
    assertEquals(f.turns.u?.state === "known" && f.turns.u.final, false);
    await f.scan();
    const before = structuredClone(f.turns.u),
      total = structuredClone(f.saved()?.summary.total);
    f.seed("a6", 6, "assistant", { cost: 2, tokens: zero });
    f.sink.invalidate(id, 1);
    await f.step();
    assertEquals(
      f.turns.u,
      before,
      "partial replacement must retain the committed turn",
    );
    assertEquals(f.saved()?.summary.total, total);
    await f.scan();
    assertEquals(derivedValue(f.turns.u)?.cost, 6);
    f.db.exec("DELETE FROM session_message WHERE type='assistant'");
    f.sink.invalidate(id, 2);
    await f.scan();
    assertEquals(f.turns.u, undefined);
  } finally {
    await f.close();
  }
});

Deno.test("V2 fully indexed idle population schedules no digest work or SQLite writes", async () => {
  const f = await fixture(true), keys: string[] = [];
  const policy = { ...cfg().digest, cpu: 1, background: true, idlems: 1 };
  let steps = 0;
  const scheduler = new DigestScheduler(policy, {
    freeMemory: () => Number.MAX_SAFE_INTEGER,
    sleep: (ms, signal) =>
      new Promise<void>((resolve, reject) => {
        const t = setTimeout(resolve, ms);
        signal.addEventListener("abort", () => {
          clearTimeout(t);
          reject(signal.reason);
        }, { once: true });
      }),
  });
  scheduler.register({
    identity: f.sink.identity,
    catalog: f.sink.catalog.bind(f.sink),
    detail: f.sink.detail.bind(f.sink),
    close() {},
    step: (...args) => {
      steps++;
      return f.sink.step(...args);
    },
  });
  try {
    f.db.exec("BEGIN");
    for (let n = 0; n < 4900; n++) {
      const key = `ses_idle${n}`;
      keys.push(`opcv2-${key}`);
      f.db.prepare("INSERT INTO session_v2 VALUES(?,'p','/repo',NULL,1,1)").run(
        key,
      );
      for (
        const [type, seq] of [["user", 1], ["assistant", 2], [
          "idle",
          3,
        ]] as const
      ) {
        f.db.prepare("INSERT INTO session_message VALUES(?,?,?,?,?,?)").run(
          `${key}-${type}`,
          key,
          type,
          seq,
          seq,
          JSON.stringify({
            time: { created: seq, completed: seq + 1 },
            cost: 0,
            tokens: zero,
          }),
        );
      }
    }
    f.db.exec("COMMIT");
    for (const sessionID of keys) {
      scheduler.enqueue(
        { provider: f.sink.identity, sessionID, updated: 1 },
        "background",
      );
    }
    while (scheduler.queued || scheduler.executing) {
      if (!await scheduler.tick()) await new Promise((r) => setTimeout(r, 0));
    }
    assertEquals(f.records.size, keys.length);
    for (const key of keys) assertEquals(f.sink.pending(key), false);
    const before = {
      steps,
      publications: f.publications.length,
      changes: f.sql.prepare("SELECT total_changes() AS n").get()!.n,
    };
    for (let turn = 0; turn < 100; turn++) {
      scheduler.setScope("viewer", {
        directory: "/repo",
        sessions: keys.slice(0, 20),
      });
      assertEquals(await scheduler.tick(), false);
    }
    assertEquals({
      steps,
      publications: f.publications.length,
      changes: f.sql.prepare("SELECT total_changes() AS n").get()!.n,
    }, before);
    console.info(
      `idle population=${keys.length}: additional digest steps=0, publications=0, SQLite writes=0`,
    );
  } finally {
    await scheduler.stop();
    await f.close();
  }
});

Deno.test("V2 latest reported context keeps its call through unreported replies and accepts reported zero", async () => {
  const f = await fixture();
  try {
    f.seed("u", 1, "user");
    f.seed("reported", 2, "assistant", { tokens: { ...zero, input: 30 } });
    f.seed("unreported", 3, "assistant");
    await f.scan();
    assertEquals(derivedValue(f.saved()?.summary.last)?.callID, "reported");
    f.seed("zero", 4, "assistant", { tokens: zero });
    f.sink.invalidate(id, 1);
    await f.scan();
    assertEquals(derivedValue(f.saved()?.summary.last)?.callID, "zero");
    assertEquals(derivedValue(f.saved()?.summary.last)?.context?.input, 0);
  } finally {
    await f.close();
  }
});

Deno.test("V2 an interrupted native terminal finalizes coverage independently of missing call clocks", async () => {
  const f = await fixture();
  try {
    f.seed("u", 1, "user");
    f.seed("a", 2, "assistant", { time: { created: 2 } });
    f.seed("idle", 3, "idle", { outcome: "interrupted" });
    await f.scan();
    assertEquals(f.turns.u.state === "known" && f.turns.u.final, true);
    assertEquals(derivedValue(f.turns.u)?.time?.end, undefined);
  } finally {
    await f.close();
  }
});

Deno.test("V2 completed sessions do no digest work on repeated idle admission", async () => {
  const f = await fixture();
  try {
    f.seed("u", 1, "user");
    f.seed("a", 2, "assistant", { cost: 1, tokens: zero });
    await f.scan();
    const before = f.publications.length;
    for (let n = 0; n < 20; n++) {
      assertEquals(f.sink.pending(id), false);
      await f.step();
    }
    assertEquals(
      f.publications.length,
      before,
      "idle admission must not schedule digest commits",
    );
    const retained = structuredClone(f.turns.u);
    f.sink.connection(1);
    assertEquals(f.sink.pending(id), true);
    await f.step();
    assertEquals(derivedValue(f.turns.u), derivedValue(retained));
    await f.scan();
    assertEquals(f.sink.pending(id), false);
    assertEquals(
      f.turns.u.state === "known" &&
        f.turns.u.witness.source.endsWith("connection:1"),
      true,
    );
  } finally {
    await f.close();
  }
});

Deno.test("V2 targets changed identities after coverage and never rereads unchanged headers", async () => {
  const f = await fixture();
  try {
    f.seed("u", 1, "user");
    for (let n = 2; n <= 20; n++) {
      f.seed(`a${n}`, n, "assistant", { cost: 1, tokens: zero });
    }
    f.seed("idle", 21, "idle");
    await f.scan();
    assertEquals(f.turns.u.state === "known" && f.turns.u.final, true);
    const read = f.sink.transcript.sqlHeaders.bind(f.sink.transcript),
      selections: (readonly string[] | undefined)[] = [];
    f.sink.transcript.sqlHeaders = (...args) => {
      selections.push(args[3]);
      return read(...args);
    };
    f.seed("a10", 10, "assistant", { cost: 5, tokens: zero });
    f.sink.invalidate(id, 1, ["a10"]);
    await f.scan(["a10"]);
    assertEquals(selections, [["a10"]]);
    assertEquals(derivedValue(f.turns.u)?.cost, 23);
    f.seed("a11", 11, "assistant", { cost: 3, tokens: zero });
    f.sink.invalidate(id, 2, ["a11"]);
    await f.scan();
    assertEquals(
      derivedValue(f.turns.u)?.cost,
      25,
      "lost fine keys require a full bounded reconciliation",
    );
    const before = structuredClone(f.turns.u);
    f.sink.invalidate(id, 3);
    await f.step();
    f.seed("a20", 20, "assistant", { cost: 9, tokens: zero });
    f.sink.invalidate(id, 4);
    await f.scan();
    assertEquals(derivedValue(f.turns.u)?.cost, 33);
    assertEquals(before.state === "known" && before.value.cost, 25);
    const retained = structuredClone(f.turns.u), keys = ["a10", "a11", "a12"];
    for (const key of keys) {
      f.seed(key, Number(key.slice(1)), "assistant", {
        cost: 10,
        tokens: zero,
      });
    }
    f.sink.invalidate(id, 5, keys);
    await f.step(keys);
    assertEquals(
      f.turns.u,
      retained,
      "one targeted batch cannot publish half of a covered replacement group",
    );
    await f.scan(keys);
    assertEquals(derivedValue(f.turns.u)?.cost, 54);
  } finally {
    await f.close();
  }
});

Deno.test("V2 a covered terminal turn becomes final before unrelated historical backfill", async () => {
  const f = await fixture();
  try {
    for (let n = 1; n < 8; n++) f.seed(`old${n}`, n, "user");
    f.seed("u", 10, "user");
    f.seed("reply", 11, "assistant", { cost: 1, tokens: zero });
    f.seed("idle", 12, "idle");
    await f.step();
    assertEquals(
      f.turns.u,
      undefined,
      "calls without their covered prompt cannot be final",
    );
    await f.step();
    assertEquals(f.sink.pending(id), true);
    assertEquals(f.turns.u.state === "known" && f.turns.u.final, true);
    assertEquals(derivedValue(f.turns.u)?.calls, 1);
  } finally {
    await f.close();
  }
});
