// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals, assertRejects, assertThrows } from "@std/assert";
import type { Harness } from "@otk/harness";
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
