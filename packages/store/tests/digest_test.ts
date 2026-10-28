// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals, assertThrows } from "@std/assert";
import { join } from "@std/path";
import { DigestDb, digestMigrations, DigestStore, OtkDb } from "@otk/store";
import { tempDir, test } from "../../../tests/support/resources.ts";

test("digest storage is separate, private, metadata-only and independently durable", async () => {
  const root = await tempDir("digest-");
  const user = new OtkDb(root, []);
  user.connection.exec(
    "CREATE TABLE user_data(value TEXT); INSERT INTO user_data VALUES('keep')",
  );
  const db = new DigestDb(root, [digestMigrations], { busyms: 100 });
  const store = new DigestStore(db);
  const columns = db.connection.prepare("PRAGMA table_info(digest_sessions)")
    .all().map((row) => row.name);
  assert(
    !columns.some((name) =>
      /(^|_)(body|text|parts|payload|json)($|_)/.test(String(name))
    ),
  );
  assertEquals(
    db.connection.prepare("PRAGMA busy_timeout").get()!.timeout,
    100,
  );
  assertEquals(
    db.connection.prepare("PRAGMA foreign_keys").get()!.foreign_keys,
    1,
  );
  assertEquals(Deno.statSync(join(root, "digest.db")).mode! & 0o777, 0o600);
  const session = {
    id: "tstv1-one",
    provider: "test-v1",
    parent_id: null,
    directory: "/p",
    project_id: "p",
    title: "One",
    time_created: 1,
    time_updated: 2,
    archived: 0,
    message_count: null,
    call_count: null,
    cost: null,
    input: null,
    output: null,
    reasoning: null,
    cache_read: null,
    cache_write: null,
    time_start: null,
    time_end: null,
    context_peak: null,
    last_agent: null,
    last_provider: null,
    last_model: null,
    context_input: null,
    context_output: null,
    context_reasoning: null,
    context_cache_read: null,
    context_cache_write: null,
    state: "digesting" as const,
    revision: 0,
    digested_at: null,
    native_updated_at: null,
    deleted_at: null,
    deleted_how: null,
  };
  store.commit({
    sessions: [session],
    turns: { upsert: [], remove: [] },
    bookkeeping: [],
  });
  assertThrows(
    () =>
      store.transaction(() => {
        store.markDeleted([session.id], 123, "provider");
        throw new Error("rollback");
      }),
    Error,
    "rollback",
  );
  assertEquals(store.summary([session.id]), [session]);
  assertThrows(() =>
    store.commit({
      sessions: [{ ...session, input: -1 }],
      turns: { upsert: [], remove: [] },
      bookkeeping: [],
    })
  );
  store.markDeleted([session.id], 123, "provider");
  db.close();
  const reopened = new DigestDb(root, [digestMigrations], { busyms: 100 });
  const durable = new DigestStore(reopened);
  assertEquals(durable.catalog("test-v1", "", 10)[0].deleted_at, 123);
  durable.resurrect([session.id]);
  assertEquals(durable.summary([session.id])[0].deleted_at, null);
  const other = { ...session, id: "tstv1-two" };
  const turn = {
    session_id: session.id,
    turn_id: "shared-turn",
    call_count: 1,
    cost: 0,
    input: 0,
    output: 0,
    reasoning: 0,
    cache_read: 0,
    cache_write: 0,
    time_start: null,
    time_end: null,
    context_peak: 0,
    revision: 1,
  };
  durable.commit({
    sessions: [other],
    turns: { upsert: [turn, { ...turn, session_id: other.id }], remove: [] },
    bookkeeping: [],
  });
  const first = durable.turns([session.id, other.id], "", 1);
  const second = durable.turns(
    [session.id, other.id],
    JSON.stringify([first[0].turn_id, first[0].session_id]),
    1,
  );
  assertEquals([first[0].session_id, second[0]?.session_id], [
    session.id,
    other.id,
  ]);
  assertEquals(
    user.connection.prepare("SELECT value FROM user_data").get()!.value,
    "keep",
  );
  reopened.close();
  user.close();
});
