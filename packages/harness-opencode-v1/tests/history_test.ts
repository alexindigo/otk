// SPDX-License-Identifier: LGPL-3.0-only
import { test } from "../../../tests/support/resources.ts";
import { assert, assertEquals } from "@std/assert";
import { fromFileUrl, join } from "@std/path";
import { DatabaseSync } from "node:sqlite";
import { History } from "../history.ts";
import { mergeHistory } from "@otk/protocol";
import { fixture } from "../../../tests/support/config.ts";
const file = fromFileUrl(
  new URL(
    "../../../tests/fixtures/opencode1/history-1.18.34-v4.db",
    import.meta.url,
  ),
);
test("history reads captured 1.18.34 DB, restores shell/file/agent, drops adjacent duplicates and never writes it", async () => {
  const before = await Deno.readFile(file),
    reader = new History(file),
    entries = await reader.listHistory();
  reader.close();
  assertEquals(entries.map((entry) => [entry.input, entry.mode]), [
    ["history newest", "normal"],
    ["echo history-shell", "shell"],
    ["inspect @explore [Image 1]", "normal"],
    ["history first", "normal"],
  ]);
  assertEquals(entries[2].parts.map((part) => part.kind), [
    "text",
    "agent",
    "file",
  ]);
  assertEquals(await Deno.readFile(file), before);
  assertEquals(mergeHistory([entries, entries]).length, 4);
});
test("history degrades missing schema without creation and enforces newest fifty user messages", async () => {
  const root = await fixture(),
    missing = join(root, "missing.db"),
    reader = new History(missing);
  assertEquals(await reader.listHistory(), []);
  reader.close();
  let exists = true;
  try {
    await Deno.stat(missing);
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) exists = false;
    else throw error;
  }
  assertEquals(exists, false);
  const path = join(root, "history.db");
  await Deno.copyFile(file, path);
  const db = new DatabaseSync(path),
    session = String(db.prepare("SELECT id FROM session LIMIT 1").get()!.id),
    base = Date.now();
  for (let i = 0; i < 60; i++) {
    db.prepare(
      "INSERT INTO message(id,session_id,time_created,time_updated,data) VALUES(?,?,?,?,?)",
    ).run(
      `msg_limit_${i}`,
      session,
      base + i,
      base + i,
      JSON.stringify({ role: "user" }),
    );
    db.prepare(
      "INSERT INTO part(id,message_id,session_id,time_created,time_updated,data) VALUES(?,?,?,?,?,?)",
    ).run(
      `prt_limit_${i}`,
      `msg_limit_${i}`,
      session,
      base + i,
      base + i,
      JSON.stringify({ type: "text", text: `limit ${i}` }),
    );
  }
  db.close();
  const bounded = new History(path), entries = await bounded.listHistory();
  bounded.close();
  assertEquals(entries.length, 50);
  assertEquals(entries[0].input, "limit 59");
  assertEquals(entries.at(-1)!.input, "limit 10");
  const bad = join(root, "schema.db"), invalid = new DatabaseSync(bad);
  invalid.exec("CREATE TABLE message(id TEXT)");
  invalid.close();
  const degraded = new History(bad);
  assertEquals(await degraded.listHistory(), []);
  degraded.close();
  assert(await Deno.stat(bad));
});
