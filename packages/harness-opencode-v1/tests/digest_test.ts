// SPDX-License-Identifier: LGPL-3.0-only
import { derivedValue } from "@otk/protocol";
import { cfg } from "../../../tests/support/config.ts";
import { assertAlmostEquals, assertEquals, assertRejects } from "@std/assert";
import { DatabaseSync } from "node:sqlite";
import { join } from "@std/path";
import {
  DigestNativeDb,
  type DigestSnapshot,
  opencodeV1DigestMigrations,
  OpencodeV1DigestSink,
} from "@otk/harness-opencode-v1";
import type { DigestDelta, SessionMetadata } from "@otk/protocol";
import { tempDir, test } from "../../../tests/support/resources.ts";

const policy = {
  batch: 2,
  slicems: 8,
  cpu: 1,
  memoryreserve: 1,
  maxpending: 2,
  idlems: 1,
  parallel: 3,
  background: false,
  publishrows: 2,
  retryms: 10,
  busyms: 100,
};
test("identity reads require fresh provider reachability after a verified catalog and never scan headers", async () => {
  const f = await fixture();
  try {
    const signal = new AbortController().signal;
    await f.sink.catalog(signal);
    f.native.prepare(
      "UPDATE session SET parent_id='ses_parent' WHERE id='ses_one'",
    ).run();
    assertEquals(
      await f.sink.identities(["opcv1-ses_one", "opcv1-missing"], signal),
      [{ id: "opcv1-ses_one", directory: "/p", parentID: "opcv1-ses_parent" }],
    );
    assertEquals(f.queries.scans, 0);
    f.offline();
    await assertRejects(() => f.sink.identities(["opcv1-ses_one"], signal));
  } finally {
    f.close();
  }
});
test("terminal inventory accepts native session identity verification without project authority", async () => {
  const f = await fixture();
  try {
    f.seed("answer", .25, 10);
    const signal = new AbortController().signal;
    await f.sink.catalog(signal);
    assertEquals(await f.sink.identities(["opcv1-ses_one"], signal), [{
      id: "opcv1-ses_one",
      directory: "/p",
    }]);
    const rows = await f.sink.readers["supervision.terminals"]!(
      { after: "" },
      signal,
    );
    assertEquals(
      rows.map((row) => ({
        id: row.id,
        terminal: row.activity?.terminal,
      })),
      [{ id: "opcv1-ses_one", terminal: 20 }],
    );
    assertEquals(f.queries.scans, 0);
  } finally {
    f.close();
  }
});
test("requested metadata coverage is descending, inclusive and extensible without sweeping old baselines", async () => {
  const f = await fixture();
  try {
    const signal = new AbortController().signal;
    for (
      const [id, created] of [["z", 1], ["a", 2], ["y", 3], ["b", 4], [
        "x",
        5,
      ]] as const
    ) {
      f.seed(id, .25, 10);
      f.native.prepare(
        "UPDATE message SET data=json_set(data,'$.time.created',?) WHERE id=?",
      ).run(created, id);
    }
    await f.sink.catalog(signal);
    await f.sink.transcriptMetadata("opcv1-ses_one", [], signal, undefined, {
      messageID: "b",
      created: 4,
    });
    assertEquals(
      f.derived.prepare(
        "SELECT message_id FROM opcv1_messages ORDER BY time_created DESC,message_id DESC",
      ).all().map((r) => r.message_id),
      ["x", "b"],
    );
    assertEquals(f.values.get("opcv1-ses_one")!.summary.state, "digesting");
    assertEquals(
      derivedValue(f.values.get("opcv1-ses_one")!.summary.total)?.cost,
      .5,
    );
    assertEquals(
      f.derived.prepare("SELECT complete_revision FROM opcv1_scan").get()
        ?.complete_revision,
      null,
    );
    await f.sink.transcriptMetadata("opcv1-ses_one", [], signal, undefined, {
      messageID: "a",
      created: 2,
    });
    assertEquals(
      f.derived.prepare(
        "SELECT message_id FROM opcv1_messages ORDER BY time_created DESC,message_id DESC",
      ).all().map((r) => r.message_id),
      ["x", "b", "y", "a"],
    );
    assertEquals(
      f.derived.prepare("SELECT requested_message FROM opcv1_scan").get()
        ?.requested_message,
      "a",
    );
    await f.scan();
    assertEquals(
      derivedValue(f.values.get("opcv1-ses_one")!.summary.total)?.cost,
      1.25,
    );
    assertEquals(f.values.get("opcv1-ses_one")!.summary.state, "ready");
    f.native.prepare("DELETE FROM message WHERE id='z'").run();
    f.sink.invalidate("opcv1-ses_one", 2);
    await f.sink.transcriptMetadata("opcv1-ses_one", [], signal, undefined, {
      messageID: "b",
      created: 4,
    });
    assertEquals(
      derivedValue(f.values.get("opcv1-ses_one")!.summary.total)?.cost,
      1.25,
      "partial coverage cannot sweep retained older contributions",
    );
    await f.scan();
    assertEquals(
      derivedValue(f.values.get("opcv1-ses_one")!.summary.total)?.cost,
      1,
    );
  } finally {
    f.close();
  }
});
test("identity validation falls back to raw native authority when a verified file disappears", async () => {
  const f = await fixture();
  try {
    const signal = new AbortController().signal;
    await f.sink.catalog(signal);
    await Deno.rename(f.nativePath, f.nativePath + ".retired");
    assertEquals(await f.sink.identities(["opcv1-ses_one"], signal), [{
      id: "opcv1-ses_one",
      directory: "/p",
    }]);
  } finally {
    f.close();
  }
});
test("a time-budget subdivision cannot complete a short SQL boundary range before consuming it", async () => {
  const f = await fixture();
  try {
    for (const id of ["a", "b", "c", "d", "e"]) f.seed(id, .25, 10);
    const signal = new AbortController().signal,
      boundary = { messageID: "b", created: 10 };
    await f.sink.catalog(signal);
    await f.sink.step(
      {
        provider: f.sink.identity,
        sessionID: "opcv1-ses_one",
        updated: 2,
        revision: 1,
        boundary,
      },
      { rows: 100, until: 0 },
      signal,
    );
    assertEquals(
      f.derived.prepare("SELECT message_id FROM opcv1_messages").all().map(
        (row) => row.message_id,
      ),
      ["e"],
    );
    assertEquals(f.sink.covered("opcv1-ses_one", boundary), false);
    await f.sink.transcriptMetadata(
      "opcv1-ses_one",
      [],
      signal,
      undefined,
      boundary,
    );
    assertEquals(
      derivedValue(f.values.get("opcv1-ses_one")!.summary.total)?.cost,
      1,
    );
    assertEquals(f.values.get("opcv1-ses_one")!.summary.state, "digesting");
  } finally {
    f.close();
  }
});
test("catalog reconciliation yields committed bounded chunks before admitting the remaining identities", async () => {
  let previous = 0, maximum = 0, interleaved = 0;
  const f: Awaited<ReturnType<typeof fixture>> = await fixture(
    async (readiness) => {
      const value = await readiness;
      const count = f.values.size;
      maximum = Math.max(maximum, count - previous);
      if (count > 0 && count < 11) interleaved++;
      previous = count;
      return value;
    },
  );
  try {
    for (let i = 0; i < 10; i++) {
      f.native.prepare(
        "INSERT INTO session VALUES(?,NULL,'/p','p','More',1,2,NULL)",
      ).run(`ses_more${i}`);
    }
    await f.sink.catalog(new AbortController().signal);
    maximum = Math.max(maximum, f.values.size - previous);
    assertEquals(f.values.size, 11);
    assertEquals(
      maximum <= policy.batch,
      true,
      `unbounded catalog commit: ${maximum}`,
    );
    assertEquals(interleaved > 0, true);
  } finally {
    f.close();
  }
});
for (const admission of ["metadata", "helper", "helper-hint"] as const) {
  for (const reconcile of [false, true]) {
    test(`catalog join preserves ${admission} admitted after enumeration (reconcile=${reconcile})`, async () => {
      const f = await fixture();
      const entered = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      try {
        const signal = new AbortController().signal;
        f.duringCatalog(async () => {
          entered.resolve();
          await release.promise;
        });
        const older = f.sink.catalog(signal, reconcile);
        await entered.promise;
        // Behind the enumeration cursor and absent from its newest API sample.
        f.native.exec(
          "INSERT INTO session VALUES('ses_before',NULL,'/p','p','New',0,2,NULL)",
        );
        if (admission === "metadata") f.sink.invalidate("opcv1-ses_before", 1);
        else {
          assertEquals(
            f.sink.requestHelper("opcv1-ses_before", admission === "helper"),
            true,
          );
          // A repeated hint must retain fresh inventory demand without restarting
          // the helper's existing sweep.
          assertEquals(f.sink.requestHelper("opcv1-ses_before", false), true);
        }
        const later = [
          f.sink.catalog(signal, false),
          f.sink.catalog(signal, false),
        ];
        release.resolve();
        assertEquals((await older).entries.map((row) => row.id), [
          "opcv1-ses_one",
        ]);
        for (const result of await Promise.all(later)) {
          assertEquals(
            result.entries.some((row) => row.id === "opcv1-ses_before"),
            true,
          );
        }
        assertEquals(f.values.get("opcv1-ses_before")?.deleted, null);
        assertEquals(
          f.derived.prepare("SELECT generation FROM opcv1_inventory").get()
            ?.generation,
          2,
          "Later callers share one fresh enumeration, not one enumeration per waiter",
        );
      } finally {
        release.resolve();
        f.close();
      }
    });
  }
}
test("accepted deletion is durable without inventory, idempotent, generation-fenced and resurrectable", async () => {
  const f = await fixture();
  try {
    f.sink.connection(2);
    await f.sink.catalog(new AbortController().signal);
    f.seed("a", .25, 10);
    await f.scan();
    f.offline();
    const deleted = Reflect.get(f.sink, "deleted");
    await Reflect.apply(deleted, f.sink, [1, "opcv1-ses_one", 1]);
    assertEquals(f.values.get("opcv1-ses_one")!.deleted, null);
    await Reflect.apply(deleted, f.sink, [2, "opcv1-ses_one", 2]);
    assertEquals(f.values.get("opcv1-ses_one")!.deleted?.how, "provider");
    assertEquals(
      derivedValue(f.values.get("opcv1-ses_one")!.summary.total)?.cost,
      .25,
    );
    const revision = f.values.get("opcv1-ses_one")!.summary.revision;
    await Reflect.apply(deleted, f.sink, [2, "opcv1-ses_one", 2]);
    assertEquals(f.values.get("opcv1-ses_one")!.summary.revision, revision);
    f.online();
    await f.sink.catalog(new AbortController().signal);
    assertEquals(f.values.get("opcv1-ses_one")!.deleted, null);
    await Reflect.apply(deleted, f.sink, [2, "opcv1-ses_one", 2]);
    assertEquals(f.values.get("opcv1-ses_one")!.deleted, null);
    await f.sink.deleteIntent("opcv1-ses_one", "owned", "begin", 2);
    await Reflect.apply(deleted, f.sink, [2, "opcv1-ses_one", 3]);
    assertEquals(f.values.get("opcv1-ses_one")!.deleted?.how, "otk");
    await f.sink.deleteIntent("opcv1-ses_one", "owned", "confirmed", 2);
    f.sink.connection(3);
    await f.sink.catalog(new AbortController().signal);
    await Reflect.apply(deleted, f.sink, [3, "opcv1-ses_one", 4]);
    assertEquals(f.values.get("opcv1-ses_one")!.deleted?.how, "provider");
  } finally {
    f.close();
  }
});
async function fixture(
  wait?: <T>(readiness: Promise<T>) => Promise<T>,
  admission?: (signal: AbortSignal) => Promise<() => void>,
) {
  const root = await tempDir("native-digest-");
  const path = join(root, "native.db");
  const native = new DatabaseSync(path);
  // The queried subset of the actual 1.18.34 fixture schema, never upstream HEAD.
  native.exec(
    "CREATE TABLE session(id TEXT PRIMARY KEY,parent_id TEXT,directory TEXT,project_id TEXT,title TEXT,time_created INTEGER,time_updated INTEGER,time_archived INTEGER); CREATE TABLE message(id TEXT PRIMARY KEY,session_id TEXT,data TEXT); CREATE TABLE part(id TEXT PRIMARY KEY,message_id TEXT,session_id TEXT,data TEXT)",
  );
  native.prepare("INSERT INTO session VALUES(?,NULL,'/p','p','One',1,2,NULL)")
    // Native collection order now uses the indexed storage creation clock.
    .run("ses_one");
  native.exec(
    "ALTER TABLE message ADD COLUMN time_created INTEGER GENERATED ALWAYS AS (CASE WHEN json_valid(data) THEN json_extract(data,'$.time.created') ELSE 0 END) VIRTUAL; CREATE INDEX message_order ON message(session_id,time_created,id)",
  );
  const derived = new DatabaseSync(":memory:");
  for (const migration of opencodeV1DigestMigrations.migrations) {
    derived.exec(Deno.readTextFileSync(migration.sql));
  }
  const values = new Map<
    string,
    DigestSnapshot & { turns: DigestDelta["turns"]["upsert"] }
  >();
  const publications: DigestDelta[] = [];
  let apiCatalog = true;
  let catalogHook: (() => void | Promise<void>) | undefined;
  let failWrite = false;
  let sqlUnavailable = false;
  const apiPages: (string | null)[] = [];
  const queries = { scans: 0, replacements: 0 };
  class CountedDb extends DigestNativeDb {
    override headers(...args: Parameters<DigestNativeDb["headers"]>) {
      queries.scans++;
      if (sqlUnavailable) throw new Error("native SQL lost");
      return super.headers(...args);
    }
    override replacements(...args: Parameters<DigestNativeDb["replacements"]>) {
      queries.replacements++;
      return super.replacements(...args);
    }
  }
  const sink = new OpencodeV1DigestSink(
    {
      harness: {
        url: "http://fixture",
        db: path,
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
      transaction(run) {
        derived.exec("BEGIN IMMEDIATE");
        const before = structuredClone(values);
        try {
          const result = run();
          derived.exec("COMMIT");
          return result;
        } catch (error) {
          derived.exec("ROLLBACK");
          values.clear();
          for (const [id, value] of before) values.set(id, value);
          throw error;
        }
      },
      read: (id) => values.get(id),
      known: () => values.values(),
      turn: (id, turn) => values.get(id)?.turns[turn],
      write(metadata: SessionMetadata, delta: DigestDelta) {
        if (failWrite) {
          failWrite = false;
          throw new Error("injected commit failure");
        }
        const turns = {
          ...values.get(metadata.id)?.turns,
          ...delta.turns.upsert,
        };
        for (const id of delta.turns.remove) delete turns[id];
        values.set(
          metadata.id,
          structuredClone({
            metadata,
            summary: delta.summary,
            deleted: delta.deleted,
            turns,
          }),
        );
      },
      publish: ({ delta }) => {
        publications.push(structuredClone(delta));
      },
      diagnostic: () => {},
    },
    (async (url: URL | string | Request) => {
      const path = new URL(String(url)).pathname;
      if (path === "/global/health") {
        return Promise.resolve(
          Response.json({ healthy: apiCatalog }),
        );
      }
      if (path === "/experimental/session") {
        const hook = catalogHook;
        catalogHook = undefined;
        await hook?.();
        if (!apiCatalog) {
          return Promise.resolve(
            new Response("unavailable", { status: 503 }),
          );
        }
        return Promise.resolve(
          Response.json(
            native.prepare(
              "SELECT * FROM session ORDER BY time_created DESC,id DESC LIMIT ?",
            ).all(Number(new URL(String(url)).searchParams.get("limit") ?? 200))
              .map((row) => ({
                id: row.id,
                projectID: "p",
                title: row.title,
                directory: "/p",
                time: { created: 1, updated: 2 },
              })),
          ),
        );
      }
      if (path === "/session/ses_one") {
        return Response.json({ id: "ses_one", directory: "/p" });
      }
      if (path === "/session/ses_one/message" && sqlUnavailable) {
        const query = new URL(String(url)).searchParams;
        const before = query.get("before");
        apiPages.push(before);
        const all = native.prepare(
          "SELECT id,data FROM message ORDER BY time_created DESC,id DESC",
        ).all();
        const offset = !before
          ? 0
          : before.startsWith("api:")
          ? Number(before.slice(4))
          : (() => {
            const cursor = JSON.parse(
              atob(before.replaceAll("-", "+").replaceAll("_", "/")),
            );
            if (
              typeof cursor.time !== "number" || typeof cursor.id !== "string"
            ) throw new Error("SQL key leaked into API cursor");
            return all.findIndex((row) => row.id === cursor.id) + 1;
          })();
        const limit = Number(query.get("limit"));
        return Response.json(
          all.slice(offset, offset + limit).reverse().map((row) => ({
            info: {
              ...JSON.parse(String(row.data)),
              id: row.id,
              sessionID: "ses_one",
            },
            parts: JSON.parse(String(row.data)).role === "user"
              ? [{
                id: `p${row.id}`,
                sessionID: "ses_one",
                messageID: row.id,
                type: "text",
                text: "Real prompt",
              }]
              : [],
          })),
          {
            headers: offset + limit < all.length
              ? { "x-next-cursor": `api:${offset + limit}` }
              : {},
          },
        );
      }
      throw new Error(`Unexpected native request ${path}`);
    }) as typeof fetch,
    (path) => new CountedDb(path),
    { wait, admission },
  );
  const seed = (
    id: string,
    cost: number | null,
    input: number | null,
    completed = true,
  ) =>
    native.prepare("INSERT OR REPLACE INTO message VALUES(?,'ses_one',?)").run(
      id,
      JSON.stringify({
        role: "assistant",
        parentID: "user",
        providerID: "model-provider",
        modelID: "model",
        agent: "build",
        time: { created: 10, ...(completed ? { completed: 20 } : {}) },
        cost,
        tokens: {
          input,
          output: 2,
          reasoning: 3,
          cache: { read: 4, write: 5 },
        },
      }),
    );
  const scan = async (messages?: string[]) => {
    const job = {
      provider: sink.identity,
      sessionID: "opcv1-ses_one",
      updated: 2,
      revision: 1,
      messages,
    };
    let cursor: string | undefined;
    let slices = 0;
    do {
      cursor = await sink.step({ ...job, cursor }, {
        rows: 2,
        until: performance.now() + 8,
      }, new AbortController().signal);
      if (++slices > 50) throw new Error("Unbounded digest scan");
    } while (cursor);
    return values.get(job.sessionID)!;
  };
  return {
    sink,
    nativePath: path,
    native,
    derived,
    values,
    publications,
    seed,
    scan,
    queries,
    apiPages,
    loseSQL: () => {
      sqlUnavailable = true;
    },
    duringCatalog: (run: () => void | Promise<void>) => {
      catalogHook = run;
    },
    failNextWrite: () => {
      failWrite = true;
    },
    offline: () => {
      apiCatalog = false;
    },
    online: () => {
      apiCatalog = true;
    },
    close: () => {
      sink.close();
      native.close();
      derived.close();
    },
  };
}

test("a descending SQL checkpoint restarts in the opaque API domain without double-counting retained totals", async () => {
  const f = await fixture();
  try {
    for (const id of ["a", "b", "c", "d", "e"]) f.seed(id, .25, 10);
    const signal = new AbortController().signal;
    await f.sink.catalog(signal);
    const job = {
      provider: f.sink.identity,
      sessionID: "opcv1-ses_one",
      updated: 2,
      revision: 1,
    };
    const cursor = await f.sink.step(job, { rows: 2, until: Infinity }, signal);
    assertEquals(
      derivedValue(f.values.get(job.sessionID)?.summary.total)?.cost,
      .5,
    );
    f.loseSQL();
    assertEquals(
      await f.sink.step(
        { ...job, cursor },
        { rows: 2, until: Infinity },
        signal,
      ),
      "retry-api",
    );
    const api = await f.sink.step(job, { rows: 2, until: Infinity }, signal);
    assertEquals(api, "api:2");
    assertEquals(
      f.derived.prepare(
        "SELECT source_mode,after_created,after_message,api_cursor FROM opcv1_scan",
      ).get(),
      {
        source_mode: "api",
        after_created: null,
        after_message: null,
        api_cursor: "api:2",
      },
    );
    assertEquals(f.apiPages, [null]);
    assertEquals(
      derivedValue(f.values.get(job.sessionID)?.summary.total)?.cost,
      .5,
    );
    await f.scan();
    assertEquals(
      derivedValue(f.values.get(job.sessionID)?.summary.total)?.cost,
      1.25,
    );
    assertEquals(f.values.get(job.sessionID)?.summary.state, "ready");
    assertEquals(f.apiPages, [null, "api:2", "api:4"]);
  } finally {
    f.close();
  }
});
test("API demand stops inside a page and resumes through the native cursor owner without skipping older metadata", async () => {
  const f = await fixture();
  try {
    for (const id of ["a", "b", "c", "d", "e"]) f.seed(id, .25, 10);
    f.native.prepare(
      "UPDATE message SET data=json_set(data,'$.role','user') WHERE id='e'",
    ).run();
    const signal = new AbortController().signal;
    await f.sink.catalog(signal);
    f.loseSQL();
    await f.sink.step(
      {
        provider: f.sink.identity,
        sessionID: "opcv1-ses_one",
        updated: 2,
        revision: 1,
      },
      { rows: 2, until: Infinity },
      signal,
    );
    await f.sink.transcriptMetadata("opcv1-ses_one", [], signal, undefined, {
      messageID: "e",
      created: 10,
    });
    assertEquals(
      f.derived.prepare("SELECT message_id FROM opcv1_messages").all().map(
        (row) => row.message_id,
      ),
      ["e"],
    );
    assertEquals(
      f.apiPages.length,
      2,
      "one bounded metadata page plus the bounded prompt projection",
    );
    await f.scan();
    assertEquals(
      derivedValue(f.values.get("opcv1-ses_one")!.summary.total)?.cost,
      1,
    );
    assertEquals(f.values.get("opcv1-ses_one")!.summary.messageCount, 5);
  } finally {
    f.close();
  }
});
test("an API dirty sweep never persists its reconciliation phase as a native cursor", async () => {
  const f = await fixture();
  try {
    f.seed("a", .1, 10);
    f.seed("b", .2, 20);
    f.seed("c", .3, 30);
    const signal = new AbortController().signal;
    await f.sink.catalog(signal);
    f.loseSQL();
    const job = {
      provider: f.sink.identity,
      sessionID: "opcv1-ses_one",
      updated: 2,
      revision: 1,
    };
    await f.sink.step(job, { rows: 2, until: Infinity }, signal);
    const cursor = await f.sink.step(job, { rows: 2, until: Infinity }, signal);
    f.seed("c", 5, 100);
    f.sink.invalidate(job.sessionID, 2);
    assertEquals(
      await f.sink.step({ ...job, cursor, revision: 2 }, {
        rows: 2,
        until: Infinity,
      }, signal),
      "reconcile",
    );
    assertEquals(
      f.derived.prepare("SELECT api_cursor FROM opcv1_scan").get()?.api_cursor,
      null,
    );
    await f.scan();
    assertEquals(
      Math.round(
        derivedValue(f.values.get(job.sessionID)!.summary.total)!.cost! * 100,
      ),
      530,
    );
    assertEquals(f.apiPages, [null, "api:2", null, "api:2"]);
  } finally {
    f.close();
  }
});
test("API boundary ties follow the source's binary message identity order", async () => {
  const f = await fixture();
  try {
    for (const id of ["A", "B", "a"]) f.seed(id, .25, 10);
    const signal = new AbortController().signal;
    await f.sink.catalog(signal);
    f.loseSQL();
    await f.sink.step(
      {
        provider: f.sink.identity,
        sessionID: "opcv1-ses_one",
        updated: 2,
        revision: 1,
      },
      { rows: 2, until: Infinity },
      signal,
    );
    await f.sink.transcriptMetadata("opcv1-ses_one", [], signal, undefined, {
      messageID: "a",
      created: 10,
    });
    assertEquals(
      f.derived.prepare("SELECT message_id FROM opcv1_messages").all().map(
        (row) => row.message_id,
      ),
      ["a"],
    );
    await f.scan();
    assertEquals(
      derivedValue(f.values.get("opcv1-ses_one")!.summary.total)?.cost,
      .75,
    );
  } finally {
    f.close();
  }
});

test("yielded native hashing retains bounded resource admission instead of starting every queued batch", async () => {
  let busy = false, admissions = 0, active = 0, maximum = 0;
  const permission: (() => void)[] = [];
  const f = await fixture(undefined, async () => {
    admissions++;
    if (busy) await new Promise<void>((resolve) => permission.push(resolve));
    busy = true;
    return () => {
      busy = false;
      permission.shift()?.();
    };
  });
  f.native.exec(
    "INSERT INTO session VALUES('ses_two',NULL,'/p','p','Two',3,3,NULL)",
  );
  f.seed("a", .25, 10);
  f.seed("b", .25, 10);
  f.seed("c", .25, 10);
  f.seed("d", .25, 10);
  f.native.exec(
    "UPDATE message SET session_id='ses_two' WHERE id IN ('c','d')",
  );
  const signal = new AbortController().signal;
  await f.sink.catalog(signal);
  admissions = 0;
  const entered = Promise.withResolvers<void>(),
    release = Promise.withResolvers<void>();
  const original = crypto.subtle.digest;
  crypto.subtle.digest = async (
    ...args: Parameters<SubtleCrypto["digest"]>
  ) => {
    active++;
    maximum = Math.max(maximum, active);
    entered.resolve();
    try {
      await release.promise;
      return await original.apply(crypto.subtle, args);
    } finally {
      active--;
    }
  };
  const work = ["opcv1-ses_one", "opcv1-ses_two"].map((sessionID) =>
    f.sink.step(
      { provider: f.sink.identity, sessionID, updated: 2, revision: 1 },
      { rows: 2, until: performance.now() + 8 },
      signal,
    )
  );
  const outcome = Promise.allSettled(work);
  try {
    await entered.promise;
    assertEquals(
      admissions >= 1,
      true,
      "Native CPU work bypassed resource permission",
    );
    assertEquals(
      maximum <= 2,
      true,
      "More than one bounded native hash batch started",
    );
  } finally {
    release.resolve();
    await outcome;
    crypto.subtle.digest = original;
    f.close();
  }
});

test("essential scalar metadata proves native identity without waiting for the complete inventory", async () => {
  const entered = Promise.withResolvers<void>(),
    release = Promise.withResolvers<void>();
  let hold = true;
  const f = await fixture(async <T>(readiness: Promise<T>) => {
    const value = await readiness;
    if (hold && value === undefined) {
      hold = false;
      entered.resolve();
      await release.promise;
    }
    return value;
  });
  f.native.exec(
    "INSERT INTO session VALUES('ses_two',NULL,'/p','p','Two',3,3,NULL); INSERT INTO session VALUES('ses_three',NULL,'/p','p','Three',4,4,NULL)",
  );
  f.seed("a", .25, 10);
  const signal = new AbortController().signal;
  const catalog = f.sink.catalog(signal);
  try {
    await entered.promise;
    const metadata = await f.sink.transcriptMetadata(
      "opcv1-ses_one",
      ["user"],
      signal,
    );
    assertEquals(metadata.boundaries, [{
      turnID: "user",
      firstID: "a",
      lastID: "a",
      complete: true,
    }]);
  } finally {
    release.resolve();
    await catalog;
    f.close();
  }
});

for (
  const change of [
    "deletion",
    "newer scalar baseline",
    "newer scalar baseline after failed hash",
  ] as const
) {
  test(`a yielded header hash cannot overwrite ${change} committed by an essential continuation`, async () => {
    const entered = Promise.withResolvers<void>(),
      release = Promise.withResolvers<void>();
    let hold = false;
    const f = await fixture(async <T>(readiness: Promise<T>) => {
      const value = await readiness;
      if (hold) {
        hold = false;
        entered.resolve();
        await release.promise;
        if (change === "newer scalar baseline after failed hash") {
          throw new Error("superseded hash failure");
        }
      }
      return value;
    });
    let work: Promise<string | undefined> | undefined;
    try {
      f.seed("a", .25, 10);
      const signal = new AbortController().signal;
      await f.sink.catalog(signal);
      hold = true;
      work = f.sink.step(
        {
          provider: f.sink.identity,
          sessionID: "opcv1-ses_one",
          updated: 2,
          revision: 1,
        },
        { rows: 2, until: performance.now() + 8 },
        signal,
      );
      await entered.promise;
      if (change === "deletion") {
        await f.sink.deleted(0, "opcv1-ses_one", 2);
      } else {
        f.seed("a", .75, 20);
        await f.scan();
      }
      release.resolve();
      await work;
      if (change === "deletion") {
        assertEquals(f.values.get("opcv1-ses_one")!.deleted?.how, "provider");
      } else {
        assertEquals(
          derivedValue(f.values.get("opcv1-ses_one")!.summary.total)!.cost,
          .75,
        );
        assertEquals(f.values.get("opcv1-ses_one")!.summary.state, "ready");
      }
    } finally {
      release.resolve();
      await work;
      f.close();
    }
  });
}

test("a newly created API identity does not turn a matching paged native inventory into foreign-file fallback", async () => {
  const f = await fixture();
  try {
    f.seed("unknown", null, null);
    f.duringCatalog(() => {
      f.native.prepare(
        "INSERT INTO session VALUES('ses_new',NULL,'/p','p','New',9,10,NULL)",
      ).run();
    });
    await f.sink.catalog(new AbortController().signal);
    const value = await f.scan();
    assertEquals(value.summary.state, "ready");
    assertEquals(derivedValue(value.summary.total)!.cost, null);
    assertEquals(
      f.queries.scans > 0,
      true,
      "The verified matching database must remain the scalar header source",
    );
    assertEquals(
      f.values.has("opcv1-ses_new"),
      true,
      "The identity proof's newly observed row must join the inventory",
    );
  } finally {
    f.close();
  }
});

test("inventory absence cannot tombstone a presence fact observed after that scan began", async () => {
  const f = await fixture();
  try {
    await f.sink.catalog(new AbortController().signal);
    f.duringCatalog(() => {
      f.native.prepare(
        "INSERT INTO session VALUES('ses_older',NULL,'/p','p','Raced presence',0,2,NULL)",
      ).run();
      const one = f.values.get("opcv1-ses_one")!;
      f.sink.storage.write({
        ...one.metadata,
        id: "opcv1-ses_older",
        title: "Raced presence",
        timeCreated: 0,
      }, {
        summary: { state: "digesting", revision: 0 },
        turns: { upsert: {}, remove: [] },
        deleted: null,
      });
      f.sink.invalidate("opcv1-ses_older", 1);
    });
    await f.sink.catalog(new AbortController().signal);
    assertEquals(f.values.get("opcv1-ses_older")!.deleted, null);
    await f.sink.catalog(new AbortController().signal);
    assertEquals(f.values.get("opcv1-ses_older")!.deleted, null);
  } finally {
    f.close();
  }
});

test("a conflicting native identity cannot supply header metadata or running-directory hints", async () => {
  const f = await fixture();
  try {
    f.native.prepare("UPDATE session SET directory='/foreign'").run();
    const catalog = await f.sink.catalog(new AbortController().signal);
    assertEquals(catalog.entries[0].directory, "/p");
    assertEquals(catalog.hints, undefined);
    await f.scan();
    assertEquals(
      f.queries.scans,
      0,
      "A foreign file must never supply scalar headers",
    );
    assertEquals(f.values.get("opcv1-ses_one")!.summary.state, "unavailable");
  } finally {
    f.close();
  }
});

test("a catalog row captured before an accepted deletion cannot resurrect that retired native lifetime", async () => {
  const f = await fixture();
  try {
    f.native.prepare(
      "INSERT INTO session VALUES('ses_two',NULL,'/p','p','Unchanged identity sample',3,3,NULL)",
    ).run();
    f.sink.connection(1);
    await f.sink.catalog(new AbortController().signal);
    f.duringCatalog(async () => {
      f.native.prepare("DELETE FROM session WHERE id='ses_one'").run();
      await f.sink.deleted(1, "opcv1-ses_one", 1);
    });
    await f.sink.catalog(new AbortController().signal);
    assertEquals(f.values.get("opcv1-ses_one")!.deleted?.how, "provider");
  } finally {
    f.close();
  }
});

test("catalog empty proofs do not overtake a raced message invalidation", async () => {
  const f = await fixture();
  try {
    f.duringCatalog(() => {
      f.seed("raced", .25, 10);
      f.sink.invalidate("opcv1-ses_one", 1);
    });
    await f.sink.catalog(new AbortController().signal);
    assertEquals(f.values.get("opcv1-ses_one")!.summary.state, "digesting");
    await f.scan();
    assertEquals(f.values.get("opcv1-ses_one")!.summary.state, "ready");
    assertEquals(
      derivedValue(f.values.get("opcv1-ses_one")!.summary.total)!.cost,
      .25,
    );
  } finally {
    f.close();
  }
});

test("a new sink lifetime cannot reuse an old intent or event revision namespace", async () => {
  const f = await fixture();
  try {
    f.sink.connection(2);
    await f.sink.catalog(new AbortController().signal);
    f.sink.invalidate("opcv1-ses_one", 99);
    await f.sink.deleteIntent("opcv1-ses_one", "old-process", "begin", 2);
    const restarted = new OpencodeV1DigestSink(
      f.sink.cfg,
      policy,
      f.sink.storage,
    );
    try {
      restarted.connection(2);
      await restarted.deleted(2, "opcv1-ses_one", 1);
      assertEquals(f.values.get("opcv1-ses_one")!.deleted?.how, "provider");
    } finally {
      restarted.close();
    }
  } finally {
    f.close();
  }
});
test("deleted usage detail rejects before native reads while retaining last reported metadata", async () => {
  const f = await fixture();
  try {
    await f.sink.catalog(new AbortController().signal);
    f.seed("a", .5, 20);
    await f.scan();
    await f.sink.deleted(0, "opcv1-ses_one", 2);
    const before = f.queries.scans;
    await assertRejects(
      () =>
        f.sink.detail("opcv1-ses_one", "user", new AbortController().signal),
      Error,
      "deleted",
    );
    assertEquals(f.queries.scans, before);
    assertEquals(
      derivedValue(f.values.get("opcv1-ses_one")!.summary.total)?.cost,
      .5,
    );
  } finally {
    f.close();
  }
});

test("native scalar digest replacement, unknown accounting, sweep removal and honest detail", async () => {
  const f = await fixture();
  try {
    await f.sink.catalog(new AbortController().signal);
    f.seed("a", 0.1, 10, false);
    f.seed("b", null, null);
    let value = await f.scan();
    assertEquals(value.summary.state, "ready");
    assertEquals(value.summary.messageCount, 2);
    assertEquals(derivedValue(value.summary.total)?.cost, null);
    assertEquals(derivedValue(value.summary.total)?.tokens.input, null);
    assertEquals(derivedValue(value.summary.total)?.tokens.output, 4);
    assertEquals(derivedValue(value.summary.total)?.time?.end, undefined);
    const unknown = await f.sink.detail(
      value.metadata.id,
      "user",
      new AbortController().signal,
    );
    assertEquals(unknown.summary.cost, null);
    assertEquals(unknown.summary.tokens.input, null);
    assertEquals(unknown.calls.length, 2);
    f.seed("a", 0.1, 10);
    f.seed("b", 0.2, 20);
    const before = queriesCopy(f.queries);
    value = await f.scan(["a", "b"]);
    assertEquals(f.queries.scans, before.scans);
    assertEquals(f.queries.replacements, before.replacements + 1);
    assertEquals(
      Math.round(derivedValue(value.summary.total)!.cost! * 100),
      30,
    );
    assertEquals(derivedValue(value.summary.total)?.tokens.input, 30);
    assertEquals(derivedValue(value.summary.total)?.time?.end, 20);
    assertEquals(derivedValue(value.summary.total)?.contextPeak, 29);
    assertEquals(derivedValue(value.turns.user)!.calls, 2);
    value = await f.scan(["a", "b"]);
    assertEquals(derivedValue(value.turns.user)!.calls, 2);
    f.native.prepare("DELETE FROM message WHERE id='a'").run();
    value = await f.scan();
    assertEquals(value.summary.messageCount, 1);
    assertAlmostEquals(derivedValue(value.summary.total)!.cost!, 0.2, 1e-12);
    assertEquals(
      (await f.sink.detail(
        value.metadata.id,
        "user",
        new AbortController().signal,
      ))
        .calls.length,
      1,
    );
  } finally {
    f.close();
  }
});

test("an explicit unready turn detail digests its scalar baseline and reads no unrelated call or label", async () => {
  const f = await fixture();
  try {
    f.seed("a", null, null);
    f.seed("b", 2, 20);
    f.native.prepare(
      "UPDATE message SET data=json_set(data,'$.parentID','other') WHERE id='b'",
    ).run();
    await f.sink.catalog(new AbortController().signal);
    assertEquals(f.values.get("opcv1-ses_one")?.summary.state, "digesting");
    const detail = await f.sink.detail(
      "opcv1-ses_one",
      "user",
      new AbortController().signal,
    );
    assertEquals(detail.calls.map((call) => call.id), ["a"]);
    assertEquals(detail.summary.cost, null);
    assertEquals(detail.summary.tokens.input, null);
    assertEquals(f.values.get("opcv1-ses_one")?.summary.state, "ready");
    assertEquals(
      detail.revision,
      f.values.get("opcv1-ses_one")?.summary.revision,
    );
  } finally {
    f.close();
  }
});

test("detail reconciles a dirty scalar baseline even while its last published digest is ready", async () => {
  const f = await fixture();
  try {
    f.seed("a", 1, 1);
    await f.sink.catalog(new AbortController().signal);
    await f.scan();
    f.seed("a", 7, 7);
    f.sink.invalidate("opcv1-ses_one", 2);
    assertEquals(f.values.get("opcv1-ses_one")?.summary.state, "ready");
    const value = await f.sink.detail(
      "opcv1-ses_one",
      "user",
      new AbortController().signal,
    );
    assertEquals(value.summary.tokens.input, 7);
    assertEquals(value.calls[0].cost, 7);
  } finally {
    f.close();
  }
});

test("failed authority retains live metadata; complete disappearance tombstones and resurrection keeps identity", async () => {
  const f = await fixture();
  try {
    await f.sink.catalog(new AbortController().signal);
    await f.scan();
    f.native.exec("DELETE FROM session");
    f.offline();
    await assertRejects(() => f.sink.catalog(new AbortController().signal));
    assertEquals(f.values.get("opcv1-ses_one")?.deleted, null);
    f.online();
    await f.sink.catalog(new AbortController().signal);
    assertEquals(f.values.get("opcv1-ses_one")?.deleted?.how, "provider");
    f.native.exec(
      "INSERT INTO session VALUES('ses_one',NULL,'/p','p','Returned',1,3,NULL)",
    );
    await f.sink.catalog(new AbortController().signal);
    assertEquals(f.values.get("opcv1-ses_one")?.deleted, null);
    assertEquals(f.values.get("opcv1-ses_one")?.metadata.title, "Returned");
  } finally {
    f.close();
  }
});
function queriesCopy(value: { scans: number; replacements: number }) {
  return { ...value };
}

test("a raced edit behind a scan cursor is reconciled before any ready publication", async () => {
  const f = await fixture();
  try {
    await f.sink.catalog(new AbortController().signal);
    f.seed("a", 0.3, 30);
    f.seed("b", 0.2, 20);
    f.seed("c", 0.1, 10);
    const job = {
      provider: f.sink.identity,
      sessionID: "opcv1-ses_one",
      updated: 2,
      revision: 1,
    };
    const budget = { rows: 2, until: performance.now() + 8 },
      signal = new AbortController().signal;
    let cursor = await f.sink.step(job, budget, signal);
    // Descending acquisition makes c the already-consumed, behind-cursor edit.
    assertEquals(
      f.derived.prepare("SELECT cost FROM opcv1_messages WHERE message_id='c'")
        .get()?.cost,
      .1,
    );
    f.seed("c", 5, 100);
    f.sink.invalidate(job.sessionID, 2);
    f.publications.length = 0;
    let count = 0;
    while (cursor) {
      cursor = await f.sink.step(
        { ...job, revision: 2, cursor },
        budget,
        signal,
      );
      if (++count > 20) throw new Error("Scan did not converge");
    }
    assertEquals(
      Math.round(
        derivedValue(f.values.get(job.sessionID)!.summary.total)!.cost! * 100,
      ),
      550,
    );
    for (const delta of f.publications) {
      if (delta.summary.state === "ready") {
        assertEquals(
          Math.round(derivedValue(delta.summary.total)!.cost! * 100),
          550,
        );
      }
    }
  } finally {
    f.close();
  }
});
test("baseline and neutral summary roll back together; malformed metadata retains the last good summary", async () => {
  const f = await fixture();
  try {
    await f.sink.catalog(new AbortController().signal);
    f.seed("a", 1, 10);
    await f.scan();
    f.seed("a", 5, 20);
    f.failNextWrite();
    await assertRejects(() => f.scan(["a"]), Error, "injected commit failure");
    assertEquals(
      derivedValue(f.values.get("opcv1-ses_one")!.summary.total)?.cost,
      1,
    );
    assertEquals(
      f.derived.prepare("SELECT cost FROM opcv1_messages WHERE message_id='a'")
        .get()!.cost,
      1,
    );
    await f.scan(["a"]);
    assertEquals(
      derivedValue(f.values.get("opcv1-ses_one")!.summary.total)?.cost,
      5,
    );
    f.native.prepare("INSERT INTO message VALUES('b','ses_one','invalid-json')")
      .run();
    const value = await f.scan();
    assertEquals(value.summary.state, "unavailable");
    assertEquals(derivedValue(value.summary.total)?.cost, 5);
  } finally {
    f.close();
  }
});
test("a durable sweep cursor resumes without rereading history and authoritative empty means exact zero", async () => {
  const f = await fixture();
  try {
    await f.sink.catalog(new AbortController().signal);
    for (const id of ["a", "b", "c", "d", "e"]) f.seed(id, 0.1, 10);
    await f.scan();
    f.native.exec("DELETE FROM message");
    const job = {
      provider: f.sink.identity,
      sessionID: "opcv1-ses_one",
      updated: 2,
      revision: 2,
    };
    const budget = { rows: 2, until: performance.now() + 8 },
      signal = new AbortController().signal;
    await f.sink.step(job, budget, signal);
    const scans = f.queries.scans;
    // A new pump has no in-memory continuation; the private committed cursor owns progress.
    let cursor = await f.sink.step(job, budget, signal);
    while (cursor) {
      cursor = await f.sink.step({ ...job, cursor }, budget, signal);
    }
    const value = f.values.get(job.sessionID)!;
    assertEquals(f.queries.scans, scans);
    assertEquals(value.summary.state, "ready");
    assertEquals(value.summary.messageCount, 0);
    assertEquals(derivedValue(value.summary.total)?.cost, 0);
    assertEquals(derivedValue(value.summary.total)?.tokens.input, 0);
  } finally {
    f.close();
  }
});
