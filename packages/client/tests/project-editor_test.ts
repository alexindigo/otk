// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals } from "@std/assert";
import { assertRejects } from "@std/assert";
import { createProjectEditor } from "../project-editor.ts";
import type { ProjectEditSnapshot, ProjectPatch } from "@otk/protocol";

const snapshot: ProjectEditSnapshot = {
  directory: "/fixture",
  projectID: "repo",
  values: { name: "Before", icon: "", color: "", startScript: "" },
  fields: ["name", "color"],
  colors: [],
  hints: [],
};
Deno.test("WP9 editor hides unsupported fields, retains dirty values through refresh and sends only changed supported input", async () => {
  let written: ProjectPatch | undefined;
  const editor = createProjectEditor({
    snapshot,
    update: (_target, patch) => {
      written = patch;
      return Promise.resolve();
    },
    refresh: () =>
      Promise.resolve({
        ...snapshot,
        values: { ...snapshot.values, name: "After" },
      }),
  });
  editor.edit("name", "After");
  editor.edit("startScript", "must not send");
  editor.sync({
    ...snapshot,
    values: { ...snapshot.values, name: "Concurrent", color: "blue" },
  });
  assertEquals(editor.state.values.name, "After");
  assertEquals(editor.state.values.color, "blue");
  assertEquals(editor.state.fields, ["name", "color"]);
  await editor.save();
  assertEquals(written, { name: "After" });
  assertEquals(editor.state.dirty, false);
});

Deno.test("WP9 editor joins duplicate saves and preserves later edits and its captured target", async () => {
  let finish!: () => void, calls = 0;
  const gate = new Promise<void>((resolve) => finish = resolve);
  const editor = createProjectEditor({
    snapshot,
    update(target, patch) {
      calls++;
      assertEquals(target, { directory: "/fixture", projectID: "repo" });
      assertEquals(patch, { name: "First" });
      return gate;
    },
    refresh: () =>
      Promise.resolve({
        ...snapshot,
        values: { ...snapshot.values, name: "First" },
      }),
  });
  editor.edit("name", "First");
  const one = editor.save(), two = editor.save();
  assertEquals(one, two);
  editor.edit("name", "Later");
  editor.sync({
    ...snapshot,
    projectID: "foreign",
    values: { ...snapshot.values, name: "Foreign" },
  });
  finish();
  await one;
  assertEquals(calls, 1);
  assertEquals(editor.state.values.name, "Later");
  assertEquals(editor.state.dirty, true);
  assertEquals(editor.dismiss(() => false), false);
  assertEquals(editor.dismiss(() => true), true);
  assertEquals(editor.dismiss(), false);
  assertEquals(editor.state.confirming, true);
  editor.keepEditing();
  assertEquals(editor.state.confirming, false);
});

Deno.test("WP9 failed save keeps dirty input with action target reason and recovery", async () => {
  const editor = createProjectEditor({
    snapshot,
    update: () => Promise.reject(new Error("native offline")),
    refresh: () => Promise.resolve(snapshot),
  });
  editor.edit("name", "Kept");
  await assertRejects(() => editor.save());
  assertEquals(editor.state.values.name, "Kept");
  assertEquals(editor.state.dirty, true);
  assertEquals(editor.state.pending, false);
  assertEquals(!!editor.state.error, true);
});

Deno.test("WP9 stale icon reads cannot replace a cleared or retired icon", async () => {
  let finish!: (value: string) => void;
  const editor = createProjectEditor({
    snapshot: { ...snapshot, fields: ["icon"] },
    update: () => Promise.resolve(),
    refresh: () => Promise.resolve(snapshot),
  });
  const reading = editor.image(() =>
    new Promise((resolve) => finish = resolve)
  );
  await Promise.resolve();
  editor.edit("icon", "");
  finish("late image");
  await reading;
  assertEquals(editor.state.values.icon, "");
  const retired = editor.image(() =>
    new Promise((resolve) => finish = resolve)
  );
  await Promise.resolve();
  editor.dispose();
  finish("retired image");
  await retired;
  assertEquals(editor.state.values.icon, "");
});
