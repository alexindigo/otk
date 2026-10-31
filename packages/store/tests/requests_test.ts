// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals, assertThrows } from "@std/assert";
import {
  OtkDb,
  Prefs,
  prefsMigrations,
  type RequestRecord,
  Requests,
  requestsMigrations,
  sessionReferenceMigrations,
  Tasks,
  tasksMigrations,
} from "@otk/store";
import { test } from "../../../tests/support/resources.ts";
import { fixture } from "./support.ts";
import { prefsOptions } from "./support.ts";
import { record } from "./request-fixture.ts";

test("scope conflict witnesses outlive retention while an older native outcome is unknown", async () => {
  const db = new OtkDb(await fixture(), [requestsMigrations], { busyms: 5000 });
  const receipts = new Requests(db), window = receipts.window(0, 100);
  const old = {
    ...record(window.id, "old"),
    execution: "native" as const,
    scope_session: "tstv1-root",
    scope_resource: "title",
  };
  try {
    receipts.admit(old);
    const next = { ...old, intent_key: "newer" };
    receipts.admit(next);
    receipts.transition(next, 1, { state: "succeeded", updated_at: 20 });
    assertEquals(
      receipts.superseded(old),
      true,
      "admission order is independent of equal timestamps",
    );
    assertEquals(
      receipts.sweep(301, 64),
      0,
      "pruning must not erase evidence needed by an active outcome",
    );
    assertEquals(receipts.superseded(old), true);
    receipts.transition(old, 1, { state: "released", updated_at: 302 });
    assertEquals(receipts.sweep(303, 64), 2);
  } finally {
    db.close();
  }
});

test("request admission, CAS, expiry and bounded recovery retain unknown effects", async () => {
  const path = await fixture(),
    db = new OtkDb(path, [requestsMigrations], { busyms: 5000 });
  const other = new OtkDb(path, [requestsMigrations], { busyms: 5000 });
  try {
    const requests = new Requests(db), contender = new Requests(other);
    const window = requests.window(0, 100);
    const input = record(window.id);
    assertEquals(requests.admit(input).inserted, true);
    assertEquals(contender.admit(input).inserted, false);
    assertThrows(() =>
      contender.admit({ ...input, fingerprint: "b".repeat(64) })
    );
    assertThrows(() => contender.admit({ ...input, window_id: "different" }));
    const running = requests.transition(input, 1, {
      state: "running",
      owner_run: "run",
      updated_at: 20,
    });
    assertEquals(running.seq, 2);
    assertThrows(() => contender.transition(input, 1, { state: "running" }));
    assertThrows(() => requests.transition(input, 2, { method: "other" }));
    const pending = record(window.id, "pending");
    requests.admit(pending);
    assertEquals(requests.inFlight(undefined, 1).length, 1);
    const first = requests.inFlight(undefined, 1)[0];
    assertEquals(requests.inFlight(first, 1).length, 1);
    requests.transition(input, 2, {
      state: "succeeded",
      receipt_kind: "task",
      receipt_json: '{"id":"task"}',
    });
    assertThrows(() => requests.transition(input, 3, { state: "running" }));
    assertEquals(requests.sweep(299, 1), 0);
    assertEquals(requests.sweep(301, 1), 1);
    assertEquals(requests.get(input), undefined);
    assertEquals(requests.get(pending)?.state, "queued");
    assertThrows(() =>
      requests.admit({
        ...input,
        accepted_at: 301,
        updated_at: 301,
        retention_until: 500,
      })
    );
    assertEquals(
      requests.admit({
        ...pending,
        accepted_at: 301,
        updated_at: 301,
        retention_until: 500,
      }).inserted,
      false,
    );
    assertThrows(() =>
      requests.admit(
        { ...record(window.id, "body"), params: "secret" } as RequestRecord,
      )
    );
    assertThrows(() => requests.inFlight(undefined, 0));
    assertThrows(() => requests.window(0, Infinity));
    db.write((tx) => {
      const rejected = {
        ...record("unknown", "rejected"),
        accepted_at: 400,
        updated_at: 400,
        retention_until: 500,
      };
      assertThrows(() => requests.admit(rejected, tx));
      assertEquals(requests.get(rejected), undefined);
    });
  } finally {
    other.close();
    db.close();
  }
});

test("effect and completion receipt commit together and survive reopen without a second task", async () => {
  const path = await fixture();
  let db = new OtkDb(path, [requestsMigrations, tasksMigrations], {
    busyms: 5000,
  });
  try {
    let requests = new Requests(db), tasks = new Tasks(db);
    const input = record(requests.window(0, 100).id);
    requests.admit(input);
    assertThrows(() =>
      db.write((tx) => {
        const task = tasks.create("/p", "perf", [], tx);
        requests.transition(input, 1, {
          state: "succeeded",
          receipt_kind: "task",
          receipt_json: JSON.stringify(task),
        }, tx);
        throw new Error("before COMMIT");
      })
    );
    db.close();
    db = new OtkDb(path, [requestsMigrations, tasksMigrations], {
      busyms: 5000,
    });
    requests = new Requests(db);
    tasks = new Tasks(db);
    assertEquals(tasks.list(), []);
    assertEquals(requests.get(input)?.seq, 1);
    db.write((tx) => {
      const task = tasks.create("/p", "perf", [], tx);
      requests.transition(input, 1, {
        state: "succeeded",
        receipt_kind: "task",
        receipt_json: JSON.stringify(task),
      }, tx);
    });
    db.close();
    db = new OtkDb(path, [requestsMigrations, tasksMigrations], {
      busyms: 5000,
    });
    requests = new Requests(db);
    tasks = new Tasks(db);
    assertEquals(requests.admit(input).inserted, false);
    assertEquals(
      JSON.parse(requests.get(input)!.receipt_json!),
      tasks.list()[0],
    );
    assertEquals(tasks.list().length, 1);
    const columns = db.connection.prepare("PRAGMA table_info(request_receipts)")
      .all().map((r) => r.name);
    assertEquals(columns.includes("params"), false);
    assertEquals(columns.includes("result"), false);
  } finally {
    db.close();
  }
});

test("request migration rolls back and retries without changing existing user metadata or upgrade markers", async () => {
  const path = await fixture();
  const before = [prefsMigrations, tasksMigrations, sessionReferenceMigrations];
  let db = new OtkDb(path, before, { busyms: 5000 });
  const task = new Tasks(db).create("/p", "retained", ["opcv1-ses_a"]);
  new Prefs(db, prefsOptions).set("timestamps", true);
  const markerSchema = db.connection.prepare(
    "SELECT sql FROM sqlite_master WHERE name='session_reference_upgrades'",
  ).get();
  db.close();
  const sql = await Deno.readTextFile(
    new URL("../features/migrations/requests/001.sql", import.meta.url),
  );
  assertThrows(() =>
    new OtkDb(path, [...before, {
      feature: "requests",
      migrations: [{
        version: 1,
        sql: sql + "; INSERT INTO missing_table VALUES(1);",
      }],
    }], { busyms: 5000 })
  );
  db = new OtkDb(path, before, { busyms: 5000 });
  try {
    assertEquals(
      db.connection.prepare(
        "SELECT name FROM sqlite_master WHERE name LIKE 'request_%'",
      ).all(),
      [],
    );
    assertEquals(new Tasks(db).get(task.id), task);
    assertEquals(new Prefs(db, prefsOptions).get().timestamps, true);
  } finally {
    db.close();
  }
  db = new OtkDb(path, [...before, requestsMigrations], { busyms: 5000 });
  try {
    assertEquals(new Tasks(db).get(task.id), task);
    assertEquals(
      db.connection.prepare(
        "SELECT sql FROM sqlite_master WHERE name='session_reference_upgrades'",
      ).get(),
      markerSchema,
    );
    assertEquals(
      db.connection.prepare(
        "SELECT version FROM otk_migrations WHERE feature='requests'",
      ).get()?.version,
      1,
    );
    assertEquals(new Requests(db).inFlight(undefined, 1), []);
  } finally {
    db.close();
  }
});
