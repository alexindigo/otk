// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals, assertThrows } from "@std/assert";
import { join } from "@std/path";
import { cfg, fixture } from "../support/config.ts";
import {
  Frecency,
  frecencyMigrations,
  OtkDb,
  prefsMigrations,
} from "@otk/store";
import {
  frecencyOptions,
  registerFrecency,
  RpcRegistry,
} from "../../core/mod.ts";
import { HarnessError } from "@otk/harness";
import { Opencode1Adapter } from "@otk/harness-opencode1";
import { StreamBuffers } from "@otk/content";

Deno.test("frecency RPC uses authoritative session directory instead of a client-claimed project", async () => {
  const root = await fixture(),
    db = new OtkDb(root, [prefsMigrations, frecencyMigrations]),
    store = new Frecency(db, frecencyOptions);
  const settings = cfg();
  settings.harness.db = join(root, "missing.db");
  const adapter = new Opencode1Adapter(
    settings,
    new StreamBuffers(),
    (input) => {
      assertEquals(new URL(String(input)).pathname, "/session/ses_files");
      return Promise.resolve(Response.json({
        id: "ses_files",
        projectID: "project",
        directory: root,
        title: "Files",
        time: { created: 1, updated: 1 },
      }));
    },
  );
  const rpc = new RpcRegistry(adapter, db);
  registerFrecency(rpc, adapter, store);
  try {
    const error = assertThrows(
      () => store.bump(root, "x".repeat(4097)),
      HarnessError,
      "Invalid frecency path length or value",
    );
    assertEquals(error.code, "params");
    await rpc.dispatch(
      "frecency.bump",
      {
        sessionID: "ses_files",
        directory: "/forged-project",
        path: "src/file.ts",
      },
    );
    assertEquals(store.list("/forged-project"), []);
    assertEquals(store.list(root)[0].path, join(root, "src/file.ts"));
    assertEquals(
      await rpc.dispatch(
        "frecency.list",
        { sessionID: "ses_files", directory: "/forged-project" },
      ),
      store.list(root),
    );
  } finally {
    await adapter.core.stop();
    db.close();
  }
});
