// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals, assertThrows } from "@std/assert";
import { DigestDb, digestMigrations, DigestStore } from "@otk/store";
import { tempDir, test } from "../../../tests/support/resources.ts";
test("helper feature v2 upgrades, rolls back atomically, reopens and removes only derived metadata", async () => {
  const root = await tempDir("helper-upgrade-");
  const old = new DigestDb(root, [{
    ...digestMigrations,
    migrations: digestMigrations.migrations.slice(0, 1),
  }], { busyms: 100 });
  old.connection.exec(
    "INSERT INTO digest_sessions(id,provider,directory,project_id,title,time_created,time_updated,archived,state) VALUES('opcv1-child','opencode-v1','/p','p','Keep title',1,2,0,'ready')",
  );
  old.close();
  let db = new DigestDb(root, [digestMigrations], { busyms: 100 });
  let store = new DigestStore(db);
  const row = {
    result_meta: null,
    session_id: "opcv1-child",
    state: "ready" as const,
    revision: 1,
    tool_count: 0,
    current_name: null,
    current_title: null,
    current_start: null,
    time_start: null,
    time_end: null,
  };
  const batch = {
    sessions: [],
    turns: { upsert: [], remove: [] },
    bookkeeping: [],
    helpers: { upsert: [row], remove: [] },
  };
  assertThrows(
    () =>
      store.transaction(() => {
        store.commit(batch);
        throw new Error("reject transaction");
      }),
    Error,
    "reject transaction",
  );
  assertEquals(store.helpers([row.session_id]), []);
  assertEquals(store.summary([row.session_id])[0].title, "Keep title");
  store.commit(batch);
  db.close();
  db = new DigestDb(root, [digestMigrations], { busyms: 100 });
  store = new DigestStore(db);
  assertEquals(store.helpers([row.session_id]), [row]);
  assertThrows(() =>
    store.commit({
      ...batch,
      helpers: { upsert: [{ ...row, tool_count: -1 }], remove: [] },
    })
  );
  assertEquals(store.helpers([row.session_id]), [row]);
  store.commit({ ...batch, helpers: { upsert: [], remove: [row.session_id] } });
  assertEquals(store.helpers([row.session_id]), []);
  assertEquals(store.summary([row.session_id])[0].title, "Keep title");
  db.close();
});
