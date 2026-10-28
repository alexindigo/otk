// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals } from "@std/assert";
import { createWindow } from "@otk/client";

Deno.test("measured windows bound rows, retain disjoint pins and preserve identity anchors", () => {
  const keys = Array.from({ length: 10000 }, (_, i) => `row-${i}`);
  const window = createWindow();
  window.update(keys, () => 30);
  const first = window.range(3000, 300, 5, ["row-2"]);
  assertEquals(first.start, 95);
  assertEquals(first.end, 115);
  assertEquals(first.visibleKeys.length, 21);
  assertEquals(first.visibleKeys[0], "row-2");
  assertEquals(first.before, 2850);
  assertEquals(first.after, 300000 - 3450);
  const anchor = window.anchor(3007)!;
  assertEquals(anchor, { key: "row-100", offset: 7 });
  window.measure("row-3", 65);
  assertEquals(window.restore(anchor), 3042);
  const reordered = [...keys.slice(5), ...keys.slice(0, 5)];
  window.update(reordered, () => 30);
  assertEquals(window.restore(anchor), 2857);
  assertEquals(window.offset("row-3"), 299940);
  assert(window.range(0, 0).visibleKeys.length === 0);
  window.update([], () => 30);
  assertEquals(window.range(999, 300).visibleKeys, []);
});

Deno.test("list interaction state is scoped by server directory and optional task without DOM", async () => {
  const { createListScopes } = await import("@otk/client");
  const scopes = createListScopes();
  const a = scopes.get({ sidecarId: "one", directory: "/p" });
  a.query = "needle";
  a.anchor = { key: "row", offset: 8 };
  assertEquals(scopes.get({ sidecarId: "two", directory: "/p" }).query, "");
  assertEquals(
    scopes.get({ sidecarId: "one", directory: "/p" }, "task").query,
    "",
  );
  assertEquals(scopes.get({ sidecarId: "one", directory: "/p" }), a);
  scopes.remove("one");
  assertEquals(scopes.get({ sidecarId: "one", directory: "/p" }).query, "");
});
