// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals } from "@std/assert";
import type { ContextAction } from "@otk/client";
import {
  breadcrumbRows,
  commandRows,
} from "../components/list-presentation.ts";
Deno.test("breadcrumb projections keep coherent identities across reorder, shrink and empty snapshots", () => {
  const crumbs = Array.from(
    { length: 10 },
    (_, i) => ({ id: `s${i}`, helper: false, depth: 0 }),
  );
  const original = breadcrumbRows(crumbs);
  assertEquals(original.map((row) => row.key), crumbs.map((crumb) => crumb.id));
  assertEquals(original.filter((row) => row.first).map((row) => row.id), [
    "s0",
  ]);
  const retained = original[7];
  assertEquals(
    breadcrumbRows(crumbs.slice(0, 1)).map((row) => ({
      id: row.id,
      first: row.first,
    })),
    [{ id: "s0", first: true }],
  );
  assertEquals(breadcrumbRows([]), []);
  assertEquals(retained.id, "s7");
  assertEquals(retained.key, "s7");
  assertEquals(
    breadcrumbRows(crumbs.slice().reverse())
      .map((row) => row.id),
    crumbs.slice().reverse().map((crumb) => crumb.id),
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
