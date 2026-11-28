// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals, assertRejects, assertThrows } from "@std/assert";
import { fromFileUrl, join } from "@std/path";
import type { Harness } from "@otk/harness";
import {
  OtkDb,
  pluginStorageMigrations,
  PluginStore,
  Prefs,
  prefsMigrations,
  requestsMigrations,
  StorageAvailability,
  storageProblem,
} from "@otk/store";
import { RequestFailure } from "@otk/client";
import {
  prefsOptions,
  registerPrefs,
  RpcRegistry,
  startCore,
} from "../../core/mod.ts";
import { cfg, fixture } from "../unit/core/support.ts";
import { test } from "../support/resources.ts";
import { WsClient } from "../support/ws-client.ts";
import { waitFor } from "../support/opencode.ts";

const filesystem = Deno.env.get("OTK_STORAGE_TEST_ROOT");
async function removeIfPresent(path: string): Promise<void> {
  try {
    await Deno.remove(path);
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
  }
}
if (!filesystem) {
  Deno.test({
    name:
      "storage-full filesystem consumer proof (run scripts/tests/storage-full.sh in the assigned guest)",
    ignore: true,
    fn() {},
  });
} else {
  test("a full disposable filesystem preserves HTTP, one visible failure, read RPCs and automatic recovery", async () => {
    const root = await fixture();
    const state = join(filesystem, crypto.randomUUID());
    const settings = cfg();
    settings.auth.type = "none";
    settings.server.port = 0;
    settings.state.path = state;
    settings.requests.livenessms = 100;
    const owner = new StorageAvailability();
    const db = new OtkDb(state, [
      prefsMigrations,
      requestsMigrations,
      pluginStorageMigrations,
    ], { busyms: 0, availability: owner });
    const prefs = new Prefs(db, prefsOptions);
    const harness = {
      core: {
        kind: "external",
        version: "1",
        start(sink: Parameters<Harness["core"]["start"]>[0]) {
          sink.connection("connected");
          return Promise.resolve();
        },
        stop: () => Promise.resolve(),
        subscriptions() {},
        listSessions: () =>
          Promise.resolve({
            items: [],
            older: null,
            generation: "storage-test",
          }),
        listChildren: () => Promise.resolve([]),
        identities: () => Promise.resolve([]),
      },
      capabilities: {},
    } as unknown as Harness;
    const rpc = new RpcRegistry(harness, db);
    registerPrefs(rpc, harness, prefs);
    const app = await startCore({
      cfg: settings,
      backend: harness,
      store: db,
      prefs,
      rpc,
      staticRoot: fromFileUrl(new URL("../../web/dist/", import.meta.url)),
    });
    const base = `http://127.0.0.1:${app.server.addr.port}`;
    let client = new WsClient(base);
    const plugin = new PluginStore(db).scope("full-test");
    const metadata = {
      id: "tstv1-storage-full",
      directory: root,
      projectID: "storage-full",
      title: "before full",
      timeCreated: 1,
      timeUpdated: 1,
      archived: false,
      status: "idle" as const,
      attention: {
        permissions: 0,
        questions: 0,
        childPermissions: 0,
        childQuestions: 0,
      },
    };
    const stopProjection = app.index.observe((entry) =>
      plugin.set("observed-title", entry.title)
    );
    const filler = join(filesystem, "disposable-filler");
    let browser: Deno.ChildProcess | undefined;
    try {
      await client.connect();
      await client.rpc("prefs.set", { key: "timestamps", value: false });
      app.index.upsertMetadata(metadata);
      db.connection.exec("PRAGMA wal_checkpoint(TRUNCATE)");
      const fill = Deno.openSync(filler, { createNew: true, write: true });
      try {
        const chunk = new Uint8Array(1024 * 1024).fill(42);
        for (;;) fill.writeSync(chunk);
      } catch (error) {
        assertEquals(Reflect.get(error as object, "code"), "ENOSPC");
      } finally {
        fill.close();
      }
      try {
        plugin.set("lost", "x".repeat(1024 * 1024));
        throw new Error("Full filesystem accepted a large write");
      } catch (error) {
        assertEquals(storageProblem(error), "full");
      }
      assertThrows(() =>
        app.index.upsertMetadata({
          ...metadata,
          title: "observed after recovery",
        })
      );
      assertEquals(plugin.get("observed-title"), "before full");
      const degraded = await client.wait((frame) =>
        frame.t === "storage" && frame.state.degraded
      );
      assert(degraded.t === "storage");
      assertEquals(degraded.state.failure?.code, "storage.full");
      const response = await fetch(`${base}/api/discovery`);
      assertEquals(response.status, 200);
      await response.arrayBuffer();
      const before = client.frames.length;
      const rejection = await assertRejects(
        () => client.rpc("prefs.set", { key: "timestamps", value: true }),
        RequestFailure,
      );
      assertEquals(rejection.failure.code, "storage.full");
      assertEquals(
        client.frames.slice(before).some((frame) =>
          frame.t === "request.result" && frame.outcome.ok
        ),
        false,
      );
      assertEquals(prefs.get().timestamps, false);
      assertEquals(
        (await client.rpc<{ timestamps: boolean }>("prefs.get", {})).timestamps,
        false,
      );
      // A reconnect is a read path too: issuing its window must not write SQLite.
      await client.close();
      client = new WsClient(base);
      await client.connect();
      await client.wait((frame) =>
        frame.t === "storage" && frame.state.degraded
      );
      assertEquals(
        (await client.rpc<{ timestamps: boolean }>("prefs.get", {})).timestamps,
        false,
      );
      const release = join(root, "browser-observed-full");
      browser = new Deno.Command("node", {
        args: ["tests/support/storage-browser.mjs", base, release],
        stdout: "piped",
        stderr: "piped",
      }).spawn();
      await waitFor(
        async () => {
          try {
            await Deno.stat(release);
            return true;
          } catch {
            return false;
          }
        },
        Boolean,
        30_000,
      );
      await Deno.remove(filler);
      await client.wait((frame) =>
        frame.t === "storage" && !frame.state.degraded && frame.state.gap > 0
      );
      await waitFor(
        () => plugin.get("observed-title"),
        (title) => title === "observed after recovery",
        5000,
      );
      await waitFor(
        () => client.entry(metadata.id)?.title,
        (title) => title === "observed after recovery",
        5000,
      );
      await client.rpc("prefs.set", { key: "timestamps", value: true });
      assertEquals(prefs.get().timestamps, true);
      assertEquals(
        (await client.rpc<{ timestamps: boolean }>("prefs.get", {})).timestamps,
        true,
      );
      plugin.set("recovered", "durable");
      assertEquals(plugin.get("recovered"), "durable");
      assertEquals(plugin.get("lost"), undefined);
      db.connection.exec("PRAGMA wal_checkpoint(TRUNCATE)");
      const result = await browser.output();
      browser = undefined;
      console.log(new TextDecoder().decode(result.stdout));
      assert(result.success, new TextDecoder().decode(result.stderr));
      console.info(
        "Storage filesystem: HTTP 200, read and reconnect available, no false success, one rendered failure, writes recovered, checkpoint completed",
      );
    } finally {
      await removeIfPresent(filler);
      if (browser) {
        try {
          browser.kill("SIGTERM");
        } catch { /* Already exited. */ }
        await browser.output();
      }
      await client.close();
      stopProjection();
      await app.stop();
      await Deno.remove(state, { recursive: true });
    }
  });
}
