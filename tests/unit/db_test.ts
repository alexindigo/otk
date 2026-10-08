// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals } from "@std/assert";
import { fromFileUrl, join } from "@std/path";
import { DatabaseSync } from "node:sqlite";
import { BootstrapDb } from "../../sidecar/adapter/opencode1/db.ts";

async function fixture(): Promise<string> {
  const root = fromFileUrl(new URL("../../.test-state/", import.meta.url));
  await Deno.mkdir(root, { recursive: true });
  return join(await Deno.makeTempDir({ dir: root }), "opencode.db");
}

Deno.test("bootstrap DB selects only recent incomplete/pending directories and leaves the database unchanged", async () => {
  const file = await fixture(), db = new DatabaseSync(file);
  db.exec(
    "CREATE TABLE session (id TEXT PRIMARY KEY, directory TEXT, time_updated INTEGER); CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, data TEXT)",
  );
  const session = db.prepare("INSERT INTO session VALUES (?, ?, ?)");
  const message = db.prepare("INSERT INTO message VALUES (?, ?, ?)");
  for (
    const [id, updated] of [["busy", 100], ["pending", 100], ["idle", 100], [
      "old",
      10,
    ], ["empty", 100]] as const
  ) session.run(id, "/" + id, updated);
  const put = (
    id: string,
    sessionID: string,
    role: string,
    completed?: number,
  ) =>
    message.run(
      id,
      sessionID,
      JSON.stringify({ role, time: { created: 1, completed } }),
    );
  put("msg_busy_1", "busy", "assistant");
  put("msg_pending_1", "pending", "user");
  put("msg_idle_1", "idle", "assistant");
  put("msg_idle_2", "idle", "assistant", 100);
  put("msg_old_1", "old", "assistant");
  db.close();
  const before = await Deno.readFile(file);
  const reader = new BootstrapDb(file);
  try {
    assertEquals(reader.possiblyRunningDirectories(50).sort(), [
      "/busy",
      "/pending",
    ]);
  } finally {
    reader.close();
  }
  assertEquals(await Deno.readFile(file), before);
});

Deno.test("bootstrap DB degrades on missing schema without creating a missing database", async () => {
  const missing = await fixture(), reader = new BootstrapDb(missing);
  assertEquals(reader.possiblyRunningDirectories(0), []);
  reader.close();
  try {
    await Deno.stat(missing);
    assert(false, "Read-only bootstrap created a database");
  } catch (error) {
    assert(error instanceof Deno.errors.NotFound);
  }
  const file = await fixture(), incomplete = new DatabaseSync(file);
  incomplete.exec("CREATE TABLE session (id TEXT)");
  incomplete.close();
  const degraded = new BootstrapDb(file);
  assertEquals(degraded.possiblyRunningDirectories(0), []);
  degraded.close();
});
