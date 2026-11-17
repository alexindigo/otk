// SPDX-License-Identifier: LGPL-3.0-only
import {
  assertEquals,
  assertRejects,
  assertStrictEquals,
  assertThrows,
} from "@std/assert";
import type { Harness } from "@otk/harness";
import type { OtkDb } from "@otk/store";
import { startApplication } from "../../../application.ts";
import { ConfigError, loadServiceConfig } from "../../../core/mod.ts";
import { defaultsPath, fixture } from "./support.ts";
import { test } from "../../support/resources.ts";

test("storage busy policy layers leaf overrides and reaches the user-data connection", async () => {
  const { config } = loadServiceConfig({
    defaultsPath,
    env: { OTK_STORAGE_BUSYMS: "7", OTK_STATE_PATH: await fixture() },
  });
  assertEquals(config.storage.busyms, 7);
  assertEquals(config.digest.busyms, 100);
  const inspected = new Error("connection inspected");
  // Source-proven provider upgrades are awaited before feature hydration.
  await assertRejects(
    () =>
      startApplication(config, {} as Harness, "unused", {
        upgrade(db) {
          assertEquals(
            db.connection.prepare("PRAGMA busy_timeout").get()!.timeout,
            7,
          );
          throw inspected;
        },
      }),
    Error,
    inspected.message,
  );
  assertEquals(
    loadServiceConfig({ defaultsPath, env: { OTK_STORAGE_BUSYMS: "0" } }).config
      .storage.busyms,
    0,
  );
  for (const value of ["-1", "1.5", "9007199254740992"]) {
    const error = assertThrows(
      () =>
        loadServiceConfig({ defaultsPath, env: { OTK_STORAGE_BUSYMS: value } }),
      ConfigError,
    );
    assertEquals(
      error.problems.some((problem) => problem.includes("OTK_STORAGE_BUSYMS")),
      true,
    );
  }
});

for (const phase of ["before upgrade", "during upgrade"] as const) {
  test(`startup canceled ${phase} never acquires backend storage`, async () => {
    const { config } = loadServiceConfig({
      defaultsPath,
      env: { OTK_STATE_PATH: await fixture() },
    });
    const controller = new AbortController();
    const canceled = new DOMException("Canceled storage startup", "AbortError");
    const entered = Promise.withResolvers<void>(),
      release = Promise.withResolvers<void>();
    let database: OtkDb | undefined, acquired = 0;
    const backend = {
      core: { kind: "storage-control" },
      storage() {
        acquired++;
      },
    } as unknown as Harness;
    if (phase === "before upgrade") controller.abort(canceled);
    const pending = startApplication(config, backend, "unused", {
      signal: controller.signal,
      async upgrade(db) {
        database = db;
        entered.resolve();
        await release.promise;
      },
    });
    const outcome = pending.then(() => undefined, (error: unknown) => error);
    if (phase === "during upgrade") {
      await entered.promise;
      controller.abort(canceled);
    }
    release.resolve();
    assertStrictEquals(await outcome, canceled);
    assertEquals(
      acquired,
      0,
      "cancellation fences every post-upgrade storage acquisition",
    );
    if (phase === "during upgrade") {
      assertThrows(() => database!.connection.prepare("SELECT 1"));
    } else {assertEquals(
        database,
        undefined,
        "a pre-aborted startup never enters upgrade",
      );}
  });
}

test("a completed live upgrade admits storage, while failed upgrade never does", async () => {
  for (const fails of [false, true]) {
    const { config } = loadServiceConfig({
      defaultsPath,
      env: { OTK_STATE_PATH: await fixture() },
    });
    const upgradeFailure = new Error("Upgrade rejected"),
      inspected = new Error("Storage admitted");
    let upgraded = false, acquired = 0, database: OtkDb | undefined;
    const backend = {
      core: { kind: "storage-control" },
      storage() {
        assertEquals(upgraded, true);
        acquired++;
        throw inspected;
      },
    } as unknown as Harness;
    const pending = startApplication(config, backend, "unused", {
      async upgrade(db) {
        database = db;
        await Promise.resolve();
        if (fails) throw upgradeFailure;
        upgraded = true;
      },
    });
    assertStrictEquals(
      await pending.then(() => undefined, (error: unknown) => error),
      fails ? upgradeFailure : inspected,
    );
    assertEquals(acquired, fails ? 0 : 1);
    assertThrows(() => database!.connection.prepare("SELECT 1"));
  }
});

test("storage callback cancellation still fences feature composition", async () => {
  const { config } = loadServiceConfig({
    defaultsPath,
    env: { OTK_STATE_PATH: await fixture() },
  });
  const controller = new AbortController(),
    canceled = new DOMException("Canceled from storage", "AbortError");
  let database: OtkDb | undefined, acquired = 0;
  const backend = {
    core: { kind: "storage-control" },
    storage() {
      acquired++;
      controller.abort(canceled);
    },
  } as unknown as Harness;
  const pending = startApplication(config, backend, "unused", {
    signal: controller.signal,
    upgrade(db) {
      database = db;
    },
  });
  assertStrictEquals(
    await pending.then(() => undefined, (error: unknown) => error),
    canceled,
  );
  assertEquals(acquired, 1);
  assertThrows(() => database!.connection.prepare("SELECT 1"));
});
