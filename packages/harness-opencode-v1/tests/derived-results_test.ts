// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals } from "@std/assert";
import { DatabaseSync } from "node:sqlite";
import { derivedValue, type DigestDelta } from "@otk/protocol";
import {
  type DigestSnapshot,
  opencodeV1DigestMigrations,
  OpencodeV1DigestSink,
} from "@otk/harness-opencode-v1";
import { cfg } from "../../../tests/support/config.ts";

const id = "opcv1-ses_one";
Deno.test("V1 projection upgrade retains baselines and requests covered reconciliation", async () => {
  const sql = new DatabaseSync(":memory:");
  try {
    const migrations = opencodeV1DigestMigrations.migrations;
    for (const migration of migrations.slice(0, -1)) {
      sql.exec(await Deno.readTextFile(migration.sql));
    }
    sql.exec(
      "INSERT INTO opcv1_scan(session_id,native_id,scan_generation,observed_revision,complete_revision,dirty,after_message,covered_created,covered_message) VALUES('s','native',2,7,7,0,'old',5,'old'); INSERT INTO opcv1_messages(session_id,message_id,role,hash,scan_generation,time_created,cost) VALUES('s','call','assistant','old',2,1,1)",
    );
    sql.exec(await Deno.readTextFile(migrations.at(-1)!.sql));
    assertEquals(
      sql.prepare(
        "SELECT committed,dirty,complete_revision,after_message,covered_message FROM opcv1_scan",
      ).get(),
      {
        committed: 1,
        dirty: 1,
        complete_revision: null,
        after_message: null,
        covered_message: null,
      },
    );
    assertEquals(sql.prepare("SELECT cost FROM opcv1_messages").get()?.cost, 1);
  } finally {
    sql.close();
  }
});
async function fixture() {
  const sql = new DatabaseSync(":memory:");
  for (const m of opencodeV1DigestMigrations.migrations) {
    sql.exec(await Deno.readTextFile(m.sql));
  }
  let saved: DigestSnapshot | undefined, offline = false;
  const rows: { info: Record<string, unknown>; parts: unknown[] }[] = [];
  const turns: DigestDelta["turns"]["upsert"] = {};
  const sink = new OpencodeV1DigestSink(
    {
      ...cfg(),
      harness: {
        ...cfg().harness,
        url: "http://fixture",
        db: "missing-native.db",
      },
    },
    { ...cfg().digest, batch: 2 },
    {
      sql,
      read: () => saved,
      turn: (_id, key) => turns[key],
      known: () => saved ? [saved] : [],
      transaction: (run) => run(),
      write: (metadata, delta) => {
        saved = {
          metadata,
          summary: delta.summary,
          deleted: delta.deleted,
          helper: delta.helper ?? saved?.helper,
        };
        Object.assign(turns, delta.turns.upsert);
        for (const key of delta.turns.remove) delete turns[key];
      },
      publish() {},
      diagnostic() {},
    },
    ((input: string | URL | Request) =>
      Promise.resolve((() => {
        if (offline) return new Response("offline", { status: 503 });
        const url = new URL(String(input));
        if (url.pathname === "/global/health") {
          return Response.json({
            healthy: true,
          });
        }
        if (url.pathname === "/experimental/session") {
          return Response.json([{
            id: "ses_one",
            projectID: "p",
            directory: "/repo",
            title: "One",
            time: { created: 1, updated: 100 },
          }]);
        }
        if (url.pathname.endsWith("/message")) {
          const offset = Number(url.searchParams.get("before") ?? 0),
            limit = Number(url.searchParams.get("limit"));
          const ordered = [...rows].reverse();
          return Response.json(
            ordered.slice(offset, offset + limit).reverse(),
            {
              headers: offset + limit < ordered.length
                ? { "x-next-cursor": String(offset + limit) }
                : {},
            },
          );
        }
        throw new Error(`Unexpected request ${url}`);
      })())) as typeof fetch,
    () => {
      throw new Error("no SQL");
    },
  );
  const seed = (key: string, n: number, data: Record<string, unknown> = {}) =>
    rows.push({
      info: {
        id: key,
        sessionID: "ses_one",
        role: "assistant",
        parentID: "u",
        time: { created: n, completed: n + 1 },
        finish: "stop",
        cost: 1,
        tokens: {
          input: 30,
          output: 0,
          reasoning: 0,
          cache: { read: 0, write: 0 },
        },
        ...data,
      },
      parts: [],
    });
  const step = (cursor?: string) =>
    sink.step(
      {
        sessionID: id,
        provider: sink.identity,
        updated: 100,
        revision: 0,
        cursor,
      },
      { rows: 2, until: Infinity },
      new AbortController().signal,
    );
  const scan = async (cursor?: string) => {
    let n = 0;
    do {
      cursor = await step(cursor);
      if (++n > 50) throw new Error("scan did not converge");
    } while (cursor);
  };
  await sink.catalog(new AbortController().signal);
  return {
    sink,
    sql,
    rows,
    turns,
    seed,
    step,
    scan,
    saved: () => saved,
    offline: () => {
      offline = true;
    },
    close: () => {
      sink.close();
      sql.close();
    },
  };
}

Deno.test("V1 helper count, current tool and time survive refresh and source outage together", async () => {
  const f = await fixture();
  const step = (cursor?: string) =>
    f.sink.step(
      {
        sessionID: id,
        provider: f.sink.identity,
        updated: 100,
        revision: 0,
        projection: "helper",
        cursor,
      },
      { rows: 2, until: Infinity },
      new AbortController().signal,
    );
  const scan = async (cursor?: string) => {
    do {
      cursor = await step(cursor);
    } while (cursor);
  };
  try {
    for (let n = 1; n <= 5; n++) {
      f.seed(`a${n}`, n);
      f.rows[n - 1].parts.push({
        id: `part${n}`,
        type: "tool",
        tool: "read",
        state: { status: "completed", title: `File ${n}`, time: { start: n } },
      });
    }
    f.sink.invalidateHelper(id);
    await scan();
    const before = structuredClone(f.saved()?.helper?.progress);
    assertEquals(derivedValue(before)?.toolCount, 5);
    f.sink.invalidateHelper(id);
    const cursor = await step();
    assertEquals(f.saved()?.helper?.progress, before);
    await scan(cursor);
    const ready = structuredClone(f.saved()?.helper?.progress);
    f.sink.invalidateHelper(id);
    f.offline();
    await scan();
    assertEquals(f.saved()?.helper?.state, "unavailable");
    assertEquals(f.saved()?.helper?.progress, ready);
  } finally {
    f.close();
  }
});

Deno.test("V1 retains committed turn and total during a multi-chunk refresh and outage", async () => {
  const f = await fixture();
  try {
    for (let n = 1; n <= 5; n++) f.seed(`a${n}`, n);
    await f.scan();
    const before = structuredClone(f.turns.u),
      total = structuredClone(f.saved()?.summary.total);
    f.rows[4].info.cost = 9;
    f.sink.invalidate(id, 1);
    const cursor = await f.step();
    assertEquals(f.turns.u, before);
    assertEquals(f.saved()?.summary.total, total);
    await f.scan(cursor);
    assertEquals(derivedValue(f.turns.u)?.cost, 13);
    f.sink.invalidate(id, 2);
    f.offline();
    await f.scan();
    assertEquals(derivedValue(f.turns.u)?.cost, 13);
    assertEquals(f.saved()?.summary.stale, true);
  } finally {
    f.close();
  }
});

Deno.test("V1 latest context ignores unreported calls but accepts a reported zero", async () => {
  const f = await fixture();
  try {
    f.seed("reported", 1);
    f.seed("unreported", 2, { tokens: undefined });
    await f.scan();
    assertEquals(derivedValue(f.saved()?.summary.last)?.callID, "reported");
    f.seed("zero", 3, {
      tokens: {
        input: 0,
        output: 0,
        reasoning: 0,
        cache: { read: 0, write: 0 },
      },
    });
    f.sink.invalidate(id, 1);
    await f.scan();
    assertEquals(derivedValue(f.saved()?.summary.last)?.callID, "zero");
  } finally {
    f.close();
  }
});

Deno.test("V1 native terminal evidence finalizes covered membership without inventing a lost end clock", async () => {
  const f = await fixture();
  try {
    f.seed("failed", 1, {
      time: { created: 1 },
      error: { name: "MessageAbortedError", data: {} },
      finish: undefined,
    });
    await f.scan();
    assertEquals(f.turns.u.state === "known" && f.turns.u.final, true);
    assertEquals(derivedValue(f.turns.u)?.time?.end, undefined);
  } finally {
    f.close();
  }
});

Deno.test("V1 retains coherent non-final totals while refreshing an ongoing turn", async () => {
  const f = await fixture();
  try {
    for (let n = 1; n <= 5; n++) f.seed(`a${n}`, n, { finish: "tool-calls" });
    await f.scan();
    const before = structuredClone(f.saved()?.summary.total);
    assertEquals(before?.state === "known" && before.final, false);
    f.rows[4].info.cost = 9;
    f.sink.invalidate(id, 1);
    const cursor = await f.step();
    assertEquals(f.saved()?.summary.total, before);
    await f.scan(cursor);
    assertEquals(derivedValue(f.saved()?.summary.total)?.cost, 13);
  } finally {
    f.close();
  }
});

Deno.test("V1 a covered terminal turn becomes final before unrelated historical backfill", async () => {
  const f = await fixture();
  try {
    for (let n = 1; n < 8; n++) f.seed(`old${n}`, n, { role: "user" });
    f.seed("u", 10, { role: "user" });
    f.seed("reply", 11);
    const cursor = await f.step();
    assertEquals(typeof cursor, "string");
    assertEquals(f.sink.pending(id), true);
    assertEquals(f.turns.u.state === "known" && f.turns.u.final, true);
    assertEquals(derivedValue(f.turns.u)?.calls, 1);
  } finally {
    f.close();
  }
});
