// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals, assertRejects, assertThrows } from "@std/assert";
import { DatabaseSync } from "node:sqlite";
import { fromFileUrl, join } from "@std/path";
import { History, HistoryReader } from "../history.ts";
import { mapPromptParts } from "../prompt.ts";
import { attachmentMime } from "../attachment-mime.ts";
import { NativeRequestFailure } from "../client.ts";
import { tempDir, test } from "../../../tests/support/resources.ts";
import { cfg } from "../../../tests/support/config.ts";

const captured = fromFileUrl(
  new URL(
    "../../../tests/fixtures/opencode1/history-1.18.34-v4.db",
    import.meta.url,
  ),
);

test("project recall excludes discovered-directory headers before materializing parts", async () => {
  const root = await tempDir("history-scope-");
  const file = join(root, "native.db");
  await Deno.copyFile(captured, file);
  const db = new DatabaseSync(file), statements: string[] = [];
  const reader = new HistoryReader(() => ({
    prepare(sql: string) {
      statements.push(sql);
      return db.prepare(sql);
    },
  }), cfg().attachments);
  try {
    db.prepare("UPDATE session SET directory=?").run("/discovered");
    assert((await reader.list()).length > 0);
    statements.length = 0;
    assertEquals(await reader.list(undefined, "/leased"), []);
    assertEquals(
      statements.length,
      1,
      "Unleased prompt parts must never be read",
    );
    assert(
      statements[0].includes(
        "session_id IN (SELECT id FROM session WHERE directory=?)",
      ),
    );
    assert((await reader.list(undefined, "/discovered")).length > 0);
  } finally {
    db.close();
  }
});

Deno.test("bounded native MIME signatures preserve unknown binaries and validate complete UTF-8", () => {
  const text = (value: string) => new TextEncoder().encode(value);
  assertEquals(attachmentMime(Uint8Array.of(255, 216, 255, 0)), "image/jpeg");
  assertEquals(attachmentMime(text("GIF89a")), "image/gif");
  assertEquals(attachmentMime(text("RIFF....WEBP")), "image/webp");
  assertEquals(attachmentMime(Uint8Array.of(0xc2)), "application/octet-stream");
  assertEquals(attachmentMime(text("héllo")), "text/plain");
});

test("recall materializes a whole candidate batch with two set queries and no upload bytes", async () => {
  const statements: string[] = [], prepare = DatabaseSync.prototype.prepare;
  const history = new History(captured, cfg().attachments);
  try {
    DatabaseSync.prototype.prepare = function (sql: string) {
      statements.push(sql);
      return prepare.call(this, sql);
    };
    const rows = await history.listHistory();
    assertEquals(rows.map((row) => row.input), [
      "history newest",
      "echo history-shell",
      "inspect @explore [Image 1]",
      "history first",
    ]);
    assertEquals(JSON.stringify(rows).includes("dataBase64"), false);
    const materialization = statements.filter((sql) =>
      /FROM part|JOIN part/.test(sql)
    );
    assertEquals(materialization.length, 2, materialization.join("\n"));
    assert(materialization.every((sql) => sql.includes("json_each")));
  } finally {
    DatabaseSync.prototype.prepare = prepare;
    history.close();
  }
});

test("global mixed-role header search yields between bounded chunks and cancels before materialization", async () => {
  const root = await tempDir("history-scan-");
  const file = join(root, "native.db");
  await Deno.copyFile(captured, file);
  const db = new DatabaseSync(file);
  const session = String(
    db.prepare("SELECT id FROM session LIMIT 1").get()!.id,
  );
  const insert = db.prepare(
    "INSERT INTO message(id,session_id,time_created,time_updated,data) VALUES(?,?,?,?,?)",
  );
  for (let i = 0; i < 250; i++) {
    insert.run(
      `scan_${i}`,
      session,
      9000000000000 + i,
      1,
      '{"role":"assistant"}',
    );
  }
  const controller = new AbortController();
  let yields = 0;
  const reader = new HistoryReader(() => db, cfg().attachments, () => {
    yields++;
    controller.abort(new Error("scan retired"));
    return Promise.resolve();
  });
  try {
    await assertRejects(
      () => reader.list(controller.signal),
      Error,
      "scan retired",
    );
    assertEquals(yields, 1);
    const samples: { rows: number; elapsedMs: number }[] = [];
    let headerSQL = "";
    const prepare = DatabaseSync.prototype.prepare;
    DatabaseSync.prototype.prepare = function (sql: string) {
      const statement = prepare.call(this, sql);
      if (sql.includes("AS role FROM message")) {
        if (!headerSQL) headerSQL = sql;
        return new Proxy(statement, {
          get(target, key) {
            if (key === "all") {
              return (...args: unknown[]) => {
                const at = performance.now();
                const rows = Reflect.apply(
                  target.all,
                  target,
                  args,
                ) as ReturnType<typeof target.all>;
                samples.push({
                  rows: rows.length,
                  elapsedMs: performance.now() - at,
                });
                return rows;
              };
            }
            return Reflect.get(target, key, target);
          },
        });
      }
      return statement;
    };
    const complete = new History(file, cfg().attachments);
    try {
      const at = performance.now();
      assertEquals((await complete.listHistory())[0].input, "history newest");
      assert(samples.every((sample) => sample.rows <= 100));
      const queryPlan = prepare.call(db, "EXPLAIN QUERY PLAN " + headerSQL).all(
        100,
      ).map((row) => row.detail);
      console.info("Recall mixed-role scan measurement", {
        syntheticAssistants: 250,
        fixture: "history-1.18.34-v4.db",
        headerStatements: samples.length,
        projectedHeaderRows: samples.reduce(
          (sum, sample) => sum + sample.rows,
          0,
        ),
        elapsedMs: performance.now() - at,
        samples,
        queryPlan,
      });
    } finally {
      complete.close();
      DatabaseSync.prototype.prepare = prepare;
    }
  } finally {
    db.close();
  }
});

test("ten attachments use two set queries and an invalid or over-budget member reads zero bodies", async () => {
  const root = await tempDir("attachment-batch-");
  const file = join(root, "native.db");
  await Deno.copyFile(captured, file);
  const db = new DatabaseSync(file);
  const message = db.prepare(
    "SELECT id,session_id FROM message WHERE json_extract(data,'$.role')='user' LIMIT 1",
  ).get()!;
  const refs = Array.from(
    { length: 10 },
    (_, i) => ({ messageID: String(message.id), partID: `batch_${i}` }),
  );
  for (const ref of refs) {
    db.prepare(
      "INSERT INTO part(id,message_id,session_id,time_created,time_updated,data) VALUES(?,?,?,?,?,?)",
    ).run(
      ref.partID,
      ref.messageID,
      String(message.session_id),
      1,
      1,
      JSON.stringify({
        type: "file",
        mime: "text/plain",
        filename: ref.partID,
        url: `data:text/plain;base64,${btoa(ref.partID)}`,
      }),
    );
  }
  const queries: string[] = [];
  const reader = new HistoryReader(() => ({
    prepare(sql: string) {
      queries.push(sql);
      return db.prepare(sql);
    },
  }), cfg().attachments);
  try {
    const values = reader.attachments(refs.toReversed());
    assertEquals(
      values.map((v) => atob(v.part.dataBase64)),
      refs.toReversed().map((r) => r.partID),
    );
    assertEquals(queries.length, 2);
    queries.length = 0;
    assertThrows(() =>
      reader.attachments([...refs, { messageID: "absent", partID: "absent" }])
    );
    assertEquals(queries.length, 1);
    assertEquals(queries.some((q) => q.includes("SELECT p.data")), false);
    const limited = new HistoryReader(() => db, { maxrefs: 10, maxbytes: 1 });
    const failure = assertThrows(
      () => limited.attachments(refs),
      NativeRequestFailure,
    );
    assertEquals(failure.outcome, "rejected");
    assertEquals(failure.failure.code, "attachment.invalid");
  } finally {
    db.close();
  }
});

test("attachment batches correlate ordered refs, validate before body reads, and reject the whole batch", async () => {
  const history = new History(captured, cfg().attachments);
  try {
    const ref = (await history.listHistory()).flatMap((row) => row.parts).find((
      p,
    ) => p.kind === "file" && p.source === "history");
    assert(ref?.kind === "file" && ref.source === "history");
    const rows = await history.attachments([ref]);
    assertEquals(rows[0].ref, { messageID: ref.messageID, partID: ref.partID });
    assertEquals(atob(rows[0].part.dataBase64).length, ref.size);
    await assertRejects(() =>
      history.attachments([ref, { messageID: "missing", partID: "missing" }])
    );
    await assertRejects(() => history.attachments([ref, ref]));
    assertEquals(await history.attachments([]), []);
  } finally {
    history.close();
  }
});

test("native attachment preparation detects bytes, decodes local file URIs and rejects binary ranges", async () => {
  const root = await tempDir("m4-mime-");
  const png = Uint8Array.of(137, 80, 78, 71, 13, 10, 26, 10);
  await Deno.writeFile(join(root, "image wrong.txt"), png);
  await Deno.writeTextFile(join(root, "document.bin"), "%PDF-1.7\n");
  await Deno.writeFile(join(root, "binary.txt"), Uint8Array.of(0, 255, 1));
  await Deno.writeTextFile(join(root, "text.bin"), "hello\nworld");
  const paths = ["image wrong.txt", "document.bin", "binary.txt", "text.bin"];
  const mapped = await mapPromptParts(
    paths.map((path) => ({ kind: "file", source: "path", path })),
    root,
  );
  assertEquals(mapped.map((p) => p.type === "file" ? p.mime : undefined), [
    "image/png",
    "application/pdf",
    "application/octet-stream",
    "text/plain",
  ]);
  const uri = new URL(`file://${join(root, "image wrong.txt")}`).href;
  assertEquals(
    (await mapPromptParts([{ kind: "file", source: "path", path: uri }], root))[
      0
    ],
    mapped[0],
  );
  await assertRejects(() =>
    mapPromptParts([{
      kind: "file",
      source: "path",
      path: "binary.txt",
      range: { start: 1 },
    }], root)
  );
  await assertRejects(() =>
    mapPromptParts([{
      kind: "file",
      source: "path",
      path: "file://remote/share/image.png",
    }], root)
  );
});
