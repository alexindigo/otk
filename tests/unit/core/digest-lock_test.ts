// SPDX-License-Identifier: LGPL-3.0-only
import { DatabaseSync } from "node:sqlite";
import { assert, assertEquals } from "@std/assert";
import { DigestDb, digestMigrations } from "@otk/store";
import { tempDir, test } from "../../support/resources.ts";
import { sqliteBusy, sqliteRetry } from "../../../core/digest/sqlite-lock.ts";
import { DigestScheduler } from "@otk/harness";
import { bounded } from "../../support/resources.ts";

test("SQLite contention is a fail-fast readiness condition with a stable busy code", async () => {
  const root = await tempDir("dl-");
  const db = new DigestDb(root, [digestMigrations], { busyms: 0 });
  const contender = new DatabaseSync(root + "/digest.db");
  try {
    assertEquals(
      db.connection.prepare("PRAGMA busy_timeout").get()!.timeout,
      0,
    );
    contender.exec("BEGIN IMMEDIATE");
    const start = performance.now();
    let error: unknown;
    try {
      db.connection.exec("BEGIN IMMEDIATE");
    } catch (cause) {
      error = cause;
    }
    const elapsed = performance.now() - start;
    assert(error instanceof Error);
    console.info("SQLite lock readiness", {
      elapsed,
      fields: Object.fromEntries(
        Object.getOwnPropertyNames(error).filter((key) => key !== "stack").map(
          (key) => [key, Reflect.get(error, key)],
        ),
      ),
    });
    assertEquals(sqliteBusy(error), true);
    assertEquals(sqliteBusy(new Error("database is locked")), false);
    assertEquals(
      sqliteBusy(
        Object.assign(new Error("SQL syntax error"), {
          code: "ERR_SQLITE_ERROR",
        }),
      ),
      false,
    );
    console.info("SQLite fail-fast lock elapsed (ms)", elapsed);
  } finally {
    if (contender.isTransaction) contender.exec("ROLLBACK");
    contender.close();
    db.close();
  }
});

test("a lock-starved writer yields to an essential SQLite read and resumes after permission returns", async () => {
  const root = await tempDir("dy-");
  const db = new DigestDb(root, [digestMigrations], { busyms: 0 });
  db.connection.exec("CREATE TABLE fixture_lock(value INTEGER)");
  const blocker = new DatabaseSync(root + "/digest.db");
  const policy = {
    batch: 2,
    slicems: 8,
    cpu: 1,
    memoryreserve: 1,
    maxpending: 2,
    publishrows: 2,
    retryms: 10,
    busyms: 1000,
  };
  const scheduler = new DigestScheduler(policy, {
    freeMemory: () => 1000,
    sleep: () => Promise.resolve(),
  });
  const controller = new AbortController();
  let done = false;
  blocker.exec("BEGIN IMMEDIATE");
  const write = scheduler.execute(
    (signal, execution) =>
      sqliteRetry(
        () => {
          db.connection.prepare("INSERT INTO fixture_lock VALUES(1)").run();
        },
        signal,
        policy,
        (readiness) => execution.wait(readiness),
      ),
    controller.signal,
    "background",
  );
  const outcome = write.finally(() => {
    done = true;
  });
  void outcome.catch(() => {});
  try {
    await bounded("lock wait releases execution", scheduler.tick(), 200);
    const essential = scheduler.execute(
      () =>
        Promise.resolve(Number(
          db.connection.prepare("SELECT count(*) n FROM fixture_lock").get()!.n,
        )),
      controller.signal,
    );
    await scheduler.tick();
    assertEquals(
      await bounded("essential read during lock wait", essential, 200),
      0,
    );
    assertEquals(done, false);
    blocker.exec("ROLLBACK");
    await bounded(
      "lock readiness resumes writer",
      (async () => {
        while (!done) {
          await scheduler.tick();
          await new Promise((resolve) => setTimeout(resolve, 1));
        }
        await outcome;
      })(),
      500,
    );
    assertEquals(
      db.connection.prepare("SELECT count(*) n FROM fixture_lock").get()!.n,
      1,
    );
  } finally {
    if (blocker.isTransaction) blocker.exec("ROLLBACK");
    controller.abort();
    await scheduler.stop();
    await outcome.catch(() => {});
    blocker.close();
    db.close();
  }
});
