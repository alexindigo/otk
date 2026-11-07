// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals, assertRejects } from "@std/assert";
import { DatabaseSync } from "node:sqlite";
import { join } from "@std/path";
import { Client, DigestNativeDb } from "@otk/harness-opencode-v1";
import { SessionLists } from "../session-lists.ts";
import { cfg } from "../../../tests/support/config.ts";
import { tempDir, test } from "../../../tests/support/resources.ts";

test("@load @sessions SQL list boundary reads exactly 20 without cataloging, orders equal clocks by ID and isolates unrelated growth", async () => {
  const path = join(await tempDir("list-source-"), "native.db"),
    db = new DatabaseSync(path);
  db.exec(
    "CREATE TABLE session(id TEXT PRIMARY KEY,parent_id TEXT,directory TEXT,project_id TEXT,title TEXT,time_created INTEGER,time_updated INTEGER,time_archived INTEGER); CREATE TABLE message(id TEXT PRIMARY KEY,session_id TEXT,data TEXT); CREATE TABLE part(id TEXT PRIMARY KEY,message_id TEXT,session_id TEXT,data TEXT)",
  );
  const insert = db.prepare("INSERT INTO session VALUES(?,?,?,?,?,1,2,NULL)");
  db.exec("BEGIN");
  for (let i = 0; i < 500; i++) {
    insert.run(
      `session_${String(i).padStart(3, "0")}`,
      i < 30 ? "parent" : null,
      "/p",
      "p",
      `Session ${i}`,
    );
  }
  db.exec("COMMIT");
  const observations: { operation: string; limit?: number; rows?: number }[] =
    [];
  const native = new DigestNativeDb(
    path,
    (operation, sample) => observations.push({ operation, ...sample }),
  );
  const lists = new SessionLists(
    new Client(cfg().harness),
    () => Promise.resolve(native),
  );
  const signal = new AbortController().signal;
  try {
    const first = await lists.read({ directory: "/p" }, signal);
    assertEquals(first.items.length, 20);
    assertEquals(
      first.items.map((item) => item.id),
      Array.from({ length: 20 }, (_, i) => `opcv1-session_${499 - i}`),
    );
    assertEquals(observations, [{
      operation: "session-list",
      limit: 20,
      rows: 20,
    }]);
    assert(first.older);
    const second = await lists.read(
      { directory: "/p", before: first.older },
      signal,
    );
    assertEquals(
      second.items.map((item) => item.id),
      Array.from({ length: 20 }, (_, i) => `opcv1-session_${479 - i}`),
    );
    assertEquals(observations.length, 2);
    assertEquals(
      await lists.read({ directory: "/p", before: first.older }, signal),
      second,
    );
    assertEquals(
      observations.length,
      2,
      "coverage, not index membership, supplies a cache hit",
    );
    db.exec("BEGIN");
    for (let i = 0; i < 5000; i++) {
      insert.run(`other_${i}`, null, "/other", "other", "Other");
    }
    db.exec("COMMIT");
    lists.invalidate();
    assertEquals(
      (await lists.read({ directory: "/p" }, signal)).items,
      first.items,
    );
    assertEquals(observations.at(-1), {
      operation: "session-list",
      limit: 20,
      rows: 20,
    });
    const query = await lists.read(
      { directory: "/p", query: "Session 12" },
      signal,
    );
    assertEquals(
      query.items.length,
      11,
      "search reaches past the first 20 source rows",
    );
    const all = await lists.read({
      directory: "/p",
      query: "Session 1",
      limit: 200,
    }, signal);
    const roots = await lists.read({
      directory: "/p",
      query: "Session 1",
      limit: 200,
      parentID: null,
    }, signal);
    assertEquals(all.items.length, 111);
    assertEquals(
      roots.items.length,
      100,
      "root-only and unfiltered source coverage cannot collide",
    );
    const children = await lists.read({
      directory: "/p",
      parentID: "opcv1-parent",
    }, signal);
    assertEquals(children.items.length, 20);
    assert(children.older);
    assertEquals(
      (await lists.read({
        directory: "/p",
        parentID: "opcv1-parent",
        before: children.older,
      }, signal)).items.length,
      10,
    );
    await assertRejects(() =>
      lists.read({ directory: "/other", before: first.older! }, signal)
    );
    await assertRejects(() =>
      lists.read(
        { directory: "/p", query: "new", before: first.older! },
        signal,
      )
    );
    lists.reset();
    await assertRejects(() =>
      lists.read({ directory: "/p", before: first.older! }, signal)
    );
  } finally {
    native.close();
    db.close();
  }
});
