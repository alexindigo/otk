// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals, assertRejects, assertThrows } from "@std/assert";
import { DatabaseSync } from "node:sqlite";
import { HistoryReader } from "../history.ts";
import { opencodeV2SessionID as ids } from "../ids.ts";
import { OperationFailure } from "@otk/protocol";

function fixture() {
  const db = new DatabaseSync(":memory:");
  db.exec(`CREATE TABLE session_v2(id TEXT PRIMARY KEY,directory TEXT);
    CREATE TABLE session_message(id TEXT PRIMARY KEY,session_id TEXT,type TEXT,seq INTEGER,time_created INTEGER,data TEXT);
    CREATE TABLE blob(hash TEXT PRIMARY KEY,mime TEXT,bytes INTEGER,data BLOB);
    CREATE TABLE blob_ref(session_id TEXT,message_id TEXT,hash TEXT);
    INSERT INTO session_v2 VALUES ('one','/one'),('two','/two');`);
  const insert = (
    id: string,
    type: string,
    time: number,
    data: unknown,
    session = "one",
  ) =>
    db.prepare("INSERT INTO session_message VALUES(?,?,?,?,?,?)").run(
      id,
      session,
      type,
      time,
      time,
      JSON.stringify(data),
    );
  const hash = "a".repeat(64), bytes = new TextEncoder().encode("stored");
  db.prepare("INSERT INTO blob VALUES(?,?,?,?)").run(
    hash,
    "text/plain",
    bytes.length,
    bytes,
  );
  insert("upload", "user", 4, {
    text: "with attachments",
    files: [{
      data: "aGVsbG8=",
      name: "inline.txt",
      mime: "text/plain",
      source: { type: "uri", uri: "file:///deleted/original" },
    }, { uri: `media:${hash}`, name: "stored.txt", mime: "text/plain" }],
    agents: [{ name: "helper" }],
  });
  db.prepare("INSERT INTO blob_ref VALUES(?,?,?)").run("one", "upload", hash);
  const queries: string[] = [];
  const reader = new HistoryReader(() => ({
    prepare(sql) {
      queries.push(sql);
      return db.prepare(sql);
    },
  }), { maxrefs: 4, maxbytes: 32 });
  return { db, reader, insert, queries, hash };
}
Deno.test("V2 recall is on-intent, excludes synthetic kinds, scopes by directory and deduplicates adjacent prompts", async () => {
  const f = fixture();
  try {
    assertEquals(f.queries, []);
    f.insert("shell", "shell", 5, {
      command: "echo hi",
      output: { text: "never recall output" },
    });
    f.insert("synthetic", "synthetic", 9, { text: "not a real prompt" });
    f.insert("same1", "user", 8, { text: "repeat" });
    f.insert("same2", "user", 7, { text: "repeat" });
    f.insert("elsewhere", "user", 6, { text: "other project" }, "two");
    const result = await f.reader.list(undefined, "/one");
    assertEquals(result.map((entry) => [entry.input, entry.mode]), [
      ["repeat", "normal"],
      ["echo hi", "shell"],
      ["with attachments", "normal"],
    ]);
    assertEquals(result[2].parts, [{
      kind: "file",
      source: "history",
      messageID: "upload",
      partID: "file:0",
      name: "inline.txt",
      mime: "text/plain",
      size: 5,
    }, {
      kind: "file",
      source: "history",
      messageID: "upload",
      partID: "file:1",
      name: "stored.txt",
      mime: "text/plain",
      size: 6,
    }, { kind: "agent", name: "helper" }]);
    assert(!JSON.stringify(result).includes("aGVsbG8="));
    assert(!JSON.stringify(result).includes("deleted/original"));
    assertEquals(
      f.reader.entries([{ sessionID: ids.encode("two"), messageID: "upload" }]),
      [],
    );
    assertEquals(
      f.reader.entries([{
        sessionID: ids.encode("one"),
        messageID: "upload",
      }])[0],
      result[2],
    );
    const signal = AbortSignal.abort();
    await assertRejects(() => f.reader.list(signal));
  } finally {
    f.db.close();
  }
});
Deno.test("V2 attachment admission validates the whole batch before bytes and never reopens original paths", () => {
  const f = fixture();
  try {
    const refs = [{ messageID: "upload", partID: "file:1" }, {
      messageID: "upload",
      partID: "file:0",
    }];
    const items = f.reader.attachments(refs);
    assertEquals(
      items.map((item) => [item.ref, item.part.name, item.part.dataBase64]),
      [[refs[0], "stored.txt", "c3RvcmVk"], [
        refs[1],
        "inline.txt",
        "aGVsbG8=",
      ]],
    );
    const scalar = f.queries.findIndex((query) => query.includes("actualSize"));
    const bytes = f.queries.findIndex((query) => query.includes("AS inline"));
    assert(scalar >= 0 && bytes > scalar);
    f.queries.length = 0;
    assertThrows(
      () =>
        f.reader.attachments([...refs, {
          messageID: "missing",
          partID: "file:0",
        }]),
      OperationFailure,
    );
    assertEquals(f.queries.some((query) => query.includes("AS inline")), false);
    f.queries.length = 0;
    assertThrows(
      () => f.reader.attachments([refs[0], refs[0]]),
      OperationFailure,
    );
    assertEquals(f.queries, []);
    f.db.prepare("UPDATE blob SET bytes=33 WHERE hash=?").run(f.hash);
    assertThrows(() => f.reader.attachments(refs), OperationFailure);
    assertEquals(f.queries.some((query) => query.includes("AS inline")), false);
  } finally {
    f.db.close();
  }
});
Deno.test("V2 incompatible history DB rejects instead of empty success; inline recall survives absent blob tables", async () => {
  const f = fixture();
  try {
    f.db.exec("DROP TABLE blob_ref; DROP TABLE blob");
    assertThrows(
      () => f.reader.attachments([{ messageID: "upload", partID: "file:1" }]),
      OperationFailure,
    );
    assertEquals(
      f.reader.attachments([{ messageID: "upload", partID: "file:0" }])[0].part
        .dataBase64,
      "aGVsbG8=",
    );
    f.db.exec("DROP TABLE session_message");
    await assertRejects(() => f.reader.list());
  } finally {
    f.db.close();
  }
});
Deno.test("V2 malformed individual attachment metadata does not erase healthy recall entries", async () => {
  const f = fixture();
  try {
    f.insert("broken", "user", 10, {
      text: "Broken",
      files: ["not an attachment"],
    });
    const entries = await f.reader.list();
    assertEquals(entries.map((entry) => entry.input), ["with attachments"]);
  } finally {
    f.db.close();
  }
});
Deno.test("V2 global recall yields between bounded header chunks even when real prompts are sparse", async () => {
  const f = fixture();
  try {
    for (let i = 0; i < 1000; i++) {
      f.insert(`assistant-${i}`, "assistant", 10 + i, { content: [] });
    }
    let yields = 0;
    const reader = new HistoryReader(
      () => f.db,
      { maxrefs: 4, maxbytes: 32 },
      () => {
        yields++;
        return Promise.resolve();
      },
    );
    assertEquals((await reader.list()).map((entry) => entry.input), [
      "with attachments",
    ]);
    assert(yields >= 10, `Expected bounded raw-header yields, got ${yields}`);
    for (let i = 0; i < 1000; i++) {
      f.insert(
        `other-user-${i}`,
        "user",
        2010 + i,
        { text: "Other project" },
        "two",
      );
    }
    yields = 0;
    assertEquals(
      (await reader.list(undefined, "/one")).map((entry) => entry.input),
      ["with attachments"],
    );
    assert(
      yields >= 20,
      `Expected bounded scoped-header yields, got ${yields}`,
    );
  } finally {
    f.db.close();
  }
});
