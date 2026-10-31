// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals } from "@std/assert";
import { fromFileUrl, join } from "@std/path";
import {
  OtkDb,
  type RequestRecord,
  Requests,
  requestsMigrations,
  Tasks,
  tasksMigrations,
} from "@otk/store";
import { tempDir, test } from "../support/resources.ts";

function record(window: string): RequestRecord {
  return {
    principal: "u",
    client_id: "client",
    intent_key: "intent",
    window_id: window,
    method: "tasks.create",
    fingerprint: "a".repeat(64),
    execution: "local",
    state: "queued",
    seq: 1,
    accepted_at: 10,
    updated_at: 10,
    retention_until: 300,
    dispatched_at: null,
    owner_run: null,
    scope_session: null,
    scope_directory: "/p",
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
}

function run(path: string, inputPath: string, mode: string) {
  return new Deno.Command(Deno.execPath(), {
    args: [
      "run",
      "--allow-read",
      "--allow-write",
      "--allow-env",
      fromFileUrl(
        new URL("../support/request-receipt-process.ts", import.meta.url),
      ),
      path,
      inputPath,
      mode,
    ],
    stdout: "piped",
    stderr: "piped",
  }).output();
}

test("independent processes contend on admission and execution CAS with exactly one winner", async () => {
  const path = await tempDir("request-contention-");
  const db = new OtkDb(path, [requestsMigrations, tasksMigrations], {
    busyms: 5000,
  });
  try {
    const requests = new Requests(db);
    const input = record(requests.window(0, 100).id);
    const inputPath = join(path, "input.json");
    await Deno.writeTextFile(inputPath, JSON.stringify(input));
    for (const mode of ["admit", "claim"]) {
      const outputs = await Promise.all(
        Array.from({ length: 4 }, () => run(path, inputPath, mode)),
      );
      const results = outputs.map((output) => {
        assertEquals(output.code, 0, new TextDecoder().decode(output.stderr));
        return JSON.parse(new TextDecoder().decode(output.stdout));
      });
      assertEquals(
        results.filter((r) => r[mode === "admit" ? "inserted" : "claimed"])
          .length,
        1,
      );
    }
    assertEquals(requests.get(input)?.seq, 2);
  } finally {
    db.close();
  }
});

test("real process death before and after COMMIT preserves the effect/receipt boundary", async () => {
  const path = await tempDir("request-crash-");
  let db = new OtkDb(path, [requestsMigrations, tasksMigrations], {
    busyms: 5000,
  });
  const input = record(new Requests(db).window(0, 100).id);
  const inputPath = join(path, "input.json");
  await Deno.writeTextFile(inputPath, JSON.stringify(input));
  db.close();
  assertEquals((await run(path, inputPath, "before-commit")).code, 77);
  db = new OtkDb(path, [requestsMigrations, tasksMigrations], { busyms: 5000 });
  try {
    assertEquals(new Tasks(db).list(), []);
    assertEquals(new Requests(db).get(input)?.state, "queued");
  } finally {
    db.close();
  }
  assertEquals((await run(path, inputPath, "after-commit")).code, 78);
  db = new OtkDb(path, [requestsMigrations, tasksMigrations], { busyms: 5000 });
  try {
    const requests = new Requests(db), tasks = new Tasks(db);
    assertEquals(requests.admit(input).inserted, false);
    assertEquals(tasks.list().length, 1);
    assertEquals(
      JSON.parse(requests.get(input)!.receipt_json!),
      tasks.list()[0],
    );
  } finally {
    db.close();
  }
});
