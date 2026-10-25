// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import { DatabaseSync } from "node:sqlite";
import { Opencode1Adapter } from "@otk/harness-opencode1";
import { SessionIndex } from "@otk/harness";
import { cfg } from "../support/config.ts";
import { FakeLlm } from "../support/fake-llm.ts";
import { OpencodeTest, waitFor } from "../support/opencode.ts";
import {
  nativeVersion,
  seedProviderPackages,
} from "../support/provider-cache.ts";
import { test } from "../support/resources.ts";

test("idle project bootstrap leaves native instances and project visit clocks untouched", async () => {
  const fake = new FakeLlm();
  const oc = await OpencodeTest.start(fake, {}, {
    env: { OPENCODE_PRINT_LOGS: "1" },
  });
  const directories: string[] = [];
  const sessions: string[] = [];
  const index = new SessionIndex();
  let adapter: Opencode1Adapter | undefined;
  try {
    // Separate root commits give stock opencode genuinely distinct projects.
    for (let i = 0; i < 8; i++) {
      const directory = join(oc.root, `idle-${i}`);
      await Deno.mkdir(directory);
      for (
        const args of [
          ["init", "-b", "master", directory],
          [
            "-C",
            directory,
            "-c",
            "user.name=Fixture",
            "-c",
            "user.email=fixture@invalid",
            "commit",
            "--allow-empty",
            "-m",
            `Idle ${i}`,
          ],
        ]
      ) {
        const result = await new Deno.Command("git", {
          args,
          stdout: "piped",
          stderr: "piped",
        }).output();
        assert(result.success, new TextDecoder().decode(result.stderr));
      }
      await seedProviderPackages(join(directory, ".opencode"));
      directories.push(directory);
      const session = await oc.request<{ id: string }>("/session", {
        method: "POST",
        directory,
        body: { title: `Idle ${i}` },
      });
      sessions.push(session.id);
    }
    await oc.restart();
    assertEquals(
      (await oc.request<{ version: string }>("/global/health")).version,
      nativeVersion,
    );
    const projects = () => {
      const db = new DatabaseSync(oc.db, { readOnly: true });
      try {
        return db.prepare(
          "SELECT id,worktree,time_updated FROM project ORDER BY id",
        ).all()
          .filter((row) => directories.includes(String(row.worktree)));
      } finally {
        db.close();
      }
    };
    const rss = async () => {
      const output = await new Deno.Command("/usr/bin/ps", {
        args: ["-o", "rss=", "-p", String(oc.process.pid)],
        stdout: "piped",
        stderr: "piped",
      }).output();
      assert(output.success, new TextDecoder().decode(output.stderr));
      const value = Number(new TextDecoder().decode(output.stdout).trim());
      assert(Number.isFinite(value) && value > 0);
      return value;
    };
    const before = projects();
    assertEquals(before.length, directories.length);
    await new Promise((resolve) => setTimeout(resolve, 1000));
    const rssBefore = await rss(), logStart = oc.log.length;
    const settings = cfg();
    settings.harness.url = oc.url;
    settings.harness.db = oc.db;
    const requests: string[] = [];
    adapter = new Opencode1Adapter(settings, undefined, (input, options) => {
      requests.push(new URL(String(input)).pathname);
      return fetch(input, options);
    });
    let ready = false;
    await adapter.core.start({
      index,
      connection(state) {
        if (state === "connected") ready = true;
      },
      indexReset: (entries) => index.reset(entries),
      indexUpsert: (entry) => index.upsert(entry),
      indexRemove: (id) => index.remove(id),
      content() {},
      resync() {},
    });
    await waitFor(() => ready, Boolean);
    await new Promise((resolve) => setTimeout(resolve, 1000));
    const after = projects(), rssAfter = await rss();
    const nativeLog = oc.log.slice(logStart);
    const created = nativeLog.split("\n").filter((line) =>
      line.includes("creating instance")
    );
    const changed = after.filter((row) =>
      before.find((old) => old.id === row.id)?.time_updated !== row.time_updated
    );
    const inventory = requests.filter((path) =>
      ["/session/status", "/permission", "/question"].includes(path)
    );
    console.info(
      "NATIVE BOOTSTRAP COST",
      JSON.stringify({
        version: nativeVersion,
        projects: directories.length,
        instancesCreated: created.length,
        rssBeforeKiB: rssBefore,
        rssAfterKiB: rssAfter,
        rssDeltaKiB: rssAfter - rssBefore,
        projectClocksChanged: changed.length,
        before,
        after,
        created,
        inventoryRequests: inventory.length,
      }),
    );
    for (const id of sessions) assertEquals(index.get(id)?.status, "idle");
    assertEquals(inventory, [], "Idle projects loaded native inventories");
    assertEquals(created, [], "Idle projects created native instances");
    assertEquals(after, before, "Bootstrap changed project visit clocks");
  } finally {
    await adapter?.core.stop();
    await oc.stop();
    await fake.stop();
  }
});

test("deleted project metadata does not prevent healthy sessions connecting and receiving live status", async () => {
  const fake = new FakeLlm();
  const oc = await OpencodeTest.start(fake);
  const deleted = join(oc.root, "deleted-project");
  const index = new SessionIndex();
  const states: string[] = [];
  const held = fake.queueHeld({ chunks: ["Healthy work continues"] });
  let adapter: Opencode1Adapter | undefined;
  try {
    await Deno.mkdir(deleted);
    await oc.request("/session", {
      method: "POST",
      directory: deleted,
      body: { title: "Deleted" },
    });
    const healthy = await oc.request<{ id: string }>("/session", {
      method: "POST",
      body: { title: "Healthy" },
    });
    await oc.restart();
    await Deno.remove(deleted, { recursive: true });
    for (const path of ["/session/status", "/permission", "/question"]) {
      console.info(
        "DELETED PROJECT INVENTORY",
        path,
        await oc.request(path, { directory: deleted }),
      );
    }
    const settings = cfg();
    settings.harness.url = oc.url;
    settings.harness.db = join(oc.root, "missing.db");
    adapter = new Opencode1Adapter(settings);
    await adapter.core.start({
      index,
      connection: (state) => states.push(state),
      indexReset: (entries) => index.reset(entries),
      indexUpsert: (entry) => index.upsert(entry),
      indexRemove: (id) => index.remove(id),
      content() {},
      resync() {},
    });
    await waitFor(() => states.includes("connected"), Boolean, 5000);
    assertEquals(index.get(healthy.id)?.status, "idle");
    await oc.request(`/session/${healthy.id}/prompt_async`, {
      method: "POST",
      body: { parts: [{ type: "text", text: "Keep this project working" }] },
    });
    await waitFor(
      () => index.get(healthy.id)?.status,
      (status) => status === "busy",
    );
    held.release();
    await waitFor(
      () => index.get(healthy.id)?.status,
      (status) => status === "idle",
    );
    assertEquals(states, ["connecting", "connected"]);
  } finally {
    held.release();
    await adapter?.core.stop();
    await oc.stop();
    await fake.stop();
  }
});
