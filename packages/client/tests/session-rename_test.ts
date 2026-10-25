// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals } from "@std/assert";
import * as client from "../mod.ts";

Deno.test("rename owns cancellation, unchanged titles, retry and stale completion", async () => {
  assert("createSessionRename" in client, "Missing rename state owner");
  const { createSessionRename } = client;
  const calls: unknown[] = [];
  let fail = false;
  let release: (() => void) | undefined;
  const owner = createSessionRename({
    rename: async (target, title) => {
      calls.push([target, title]);
      if (fail) throw new Error("Rename unavailable");
      await new Promise<void>((resolve) => release = resolve);
    },
  });
  const target = { sidecarId: "a", sessionID: "s", title: "Original" };
  owner.start(target, "row");
  await owner.commit("   ");
  assertEquals(owner.state.editing, undefined);
  owner.start(target, "tab");
  await owner.commit(" Original ");
  assertEquals(calls, []);
  owner.start(target, "chip");
  fail = true;
  await owner.commit(" New ");
  assertEquals(owner.state.error, "Rename unavailable");
  assertEquals(owner.state.editing?.origin, "chip");
  fail = false;
  const commit = owner.commit(" New ");
  await Promise.resolve();
  owner.start({ ...target, sessionID: "other" }, "row");
  release!();
  await commit;
  assertEquals(owner.state.editing?.sessionID, "other");
  owner.cancel();
  assertEquals(owner.state.editing, undefined);
  assertEquals(calls.map((call) => (call as unknown[])[1]), ["New", "New"]);
});

Deno.test("rename keeps editing until the authoritative index title arrives", async () => {
  assert("createSessionRename" in client);
  let title = "Old";
  const owner = client.createSessionRename({
    rename: () => Promise.resolve(),
    title: () => title,
  });
  owner.start({ sidecarId: "a", sessionID: "s", title }, "row");
  await owner.commit("New");
  assertEquals(owner.state.pending, true);
  assertEquals(owner.state.editing?.title, "Old");
  owner.observe();
  assert(owner.state.editing);
  title = "New";
  owner.observe();
  assertEquals(owner.state.editing, undefined);
});
