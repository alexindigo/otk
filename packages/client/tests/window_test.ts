// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals } from "@std/assert";
import { createWindow } from "@otk/client";

Deno.test("window inline footprint survives range retirement and shared-cache remounts", () => {
  const heights = new Map<string, number>(), widths = new Map<string, number>();
  let revision = "lane-100";
  const make = () =>
    createWindow(heights, (key) => `${revision}:${key}`, widths);
  const window = make();
  window.update(["prose", "image"], () => 30);
  window.measure("prose", 200, 600);
  window.measure("image", 198, 230);
  assertEquals(window.range(201, 50).visibleKeys, ["image"]);
  assertEquals(window.inlineSize(), 600);
  const remounted = make();
  remounted.update(["prose", "image"], () => 30);
  assertEquals(remounted.inlineSize(), 600);
  remounted.update(["image"], () => 30);
  assertEquals(remounted.inlineSize(), 230);
  revision = "lane-125";
  remounted.update(["image"], () => 30);
  assertEquals(remounted.inlineSize(), 0);
  remounted.measure("image", 247.5, 287.5);
  assertEquals(remounted.inlineSize(), 287.5);
  remounted.clearInline();
  assertEquals(remounted.inlineSize(), 0);
  assertEquals(remounted.size("image"), 247.5);
});

Deno.test("a new source measurement revokes its previous inline contribution", () => {
  let source = "old";
  const window = createWindow(new Map(), (key) => `${source}:${key}`);
  window.update(["text"], () => 30);
  window.measure("text", 100, 600);
  source = "replacement";
  window.measure("text", 30, 120);
  assertEquals(window.inlineSize(), 120);
});

Deno.test("zero extent retains a materialization frontier without rendering the whole collection", () => {
  const window = createWindow();
  const keys = Array.from({ length: 10000 }, (_, i) => `empty-${i}`);
  window.update(keys, () => 30);
  for (const key of keys) window.measure(key, 0);
  assertEquals(window.range(0, 300).visibleKeys, ["empty-9999"]);
  assertEquals(window.range(0, 0).visibleKeys, []);
});

Deno.test("an estimate equal to the measured size is still only an estimate until recorded", () => {
  const window = createWindow();
  window.update(["source"], () => 30);
  assertEquals(window.measured("source"), false);
  assertEquals(window.measure("source", 30), true);
  assertEquals(window.measured("source"), true);
  window.update(["older", "source"], () => 30);
  assertEquals(window.measured("source"), true);
  assertEquals(window.measured("older"), false);
  assertEquals(window.measure("older", 0), true);
  assertEquals(window.measured("older"), true);
  assertEquals(window.offset("source"), 0);
  assertEquals(window.invalidate("older"), true);
  assertEquals(window.measured("older"), false);
  assertEquals(window.offset("source"), 30);
});

Deno.test("explicit interaction pins materialize nested rows outside viewport geometry", () => {
  const window = createWindow();
  window.update(["first", "middle", "last"], () => 30);
  assertEquals(window.range(900, 0, 0, ["first", "last"]).visibleKeys, [
    "first",
    "last",
  ]);
  assertEquals(window.range(900, 0).visibleKeys, []);
});

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
