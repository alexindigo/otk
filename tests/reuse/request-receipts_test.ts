// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals } from "@std/assert";
import {
  OtkDb,
  type RequestRecord,
  Requests,
  requestsMigrations,
  Tasks,
  tasksMigrations,
} from "@otk/store";
import { tempDir, test } from "../support/resources.ts";

test("independent public store consumer recovers the original task result without applying its intent twice", async () => {
  const path = await tempDir("request-consumer-");
  let db = new OtkDb(path, [tasksMigrations, requestsMigrations], {
    busyms: 5000,
  });
  const window = new Requests(db).window(0, 100);
  const intent: RequestRecord = {
    principal: "consumer",
    client_id: "tab",
    intent_key: "create",
    window_id: window.id,
    method: "external.create",
    fingerprint: "c".repeat(64),
    execution: "local",
    state: "queued",
    seq: 1,
    accepted_at: 1,
    updated_at: 1,
    retention_until: 200,
    dispatched_at: null,
    owner_run: null,
    scope_session: null,
    scope_directory: "/workspace",
    scope_resource: null,
    progress_code: null,
    progress_completed: null,
    progress_total: null,
    receipt_kind: null,
    receipt_json: null,
    error_code: null,
    error_retry: null,
    error_field: null,
    diagnostic_id: null,
  };
  const first = new Requests(db);
  first.admit(intent);
  db.write((tx) => {
    const created = new Tasks(db).create("/workspace", "original", [], tx);
    first.transition(intent, 1, {
      state: "succeeded",
      receipt_kind: "external-task",
      receipt_json: JSON.stringify(created),
    }, tx);
  });
  db.close();
  // A newer authoritative edit cannot rewrite the immutable original receipt.
  db = new OtkDb(path, [requestsMigrations, tasksMigrations], { busyms: 5000 });
  try {
    const tasks = new Tasks(db), requests = new Requests(db);
    const task = tasks.list()[0];
    tasks.rename(task.id, "newer");
    const replay = requests.admit(intent);
    assertEquals(replay.inserted, false);
    assertEquals(JSON.parse(replay.record.receipt_json!).name, "original");
    assertEquals(tasks.list().map((t) => t.name), ["newer"]);
    tasks.close(task.id);
    assertEquals(
      requests.admit(intent).record.receipt_json,
      replay.record.receipt_json,
    );
    assertEquals(tasks.list(), []);
  } finally {
    db.close();
  }
});
