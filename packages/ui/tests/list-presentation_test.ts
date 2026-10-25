// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals } from "@std/assert";
import type { ContextAction } from "@otk/client";
import {
  breadcrumbRows,
  commandRows,
} from "../components/list-presentation.ts";
Deno.test("breadcrumb projections keep identity-bound folding across edits, reorder, shrink and empty snapshots", () => {
  const crumbs = Array.from(
    { length: 10 },
    (_, i) => ({ id: `s${i}`, helper: false, depth: 0 }),
  );
  const original = breadcrumbRows(crumbs, "s4", (id) => id === "s7");
  assertEquals(original.filter((row) => row.visible).map((row) => row.id), [
    "s0",
    "s1",
    "s3",
    "s4",
    "s5",
    "s7",
    "s8",
    "s9",
  ]);
  assertEquals(original.filter((row) => row.foldStart).map((row) => row.id), [
    "s2",
    "s6",
  ]);
  const retained = original[7];
  assertEquals(
    breadcrumbRows(crumbs.slice(0, 1), "s0").map((row) => ({
      id: row.id,
      visible: row.visible,
      first: row.first,
      foldStart: row.foldStart,
    })),
    [{ id: "s0", visible: true, first: true, foldStart: false }],
  );
  assertEquals(breadcrumbRows([], "s0"), []);
  assertEquals(retained.id, "s7");
  assertEquals(retained.visible, true);
  assertEquals(
    breadcrumbRows(crumbs.slice().reverse(), "s4").filter((row) => row.visible)
      .map((row) => row.id),
    ["s9", "s8", "s5", "s4", "s3", "s1", "s0"],
  );
});
Deno.test("menu separator projections preserve exact command references through removal and reordering", () => {
  const actions = [
    { id: "one", key: "one", title: "One", args: {}, destructive: false },
    { id: "two", key: "two", title: "Two", args: {}, destructive: false },
    {
      id: "delete",
      key: "delete",
      title: "Delete",
      args: {},
      destructive: true,
    },
  ] satisfies ContextAction[];
  const original = commandRows(actions), deleted = original[2];
  assertEquals(original.map((row) => row.separator), [false, false, true]);
  assertEquals(
    commandRows([actions[2], actions[0]]).map((row) => row.separator),
    [true, false],
  );
  assertEquals(commandRows([]), []);
  assertEquals(deleted.separator, true);
  assertEquals(deleted.action === actions[2], true);
});
