// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals } from "@std/assert";
import { createStableOrder } from "../stable-order.ts";

Deno.test("stable order seeds saved/creation order, appends arrivals and accepts only saved moves", () => {
  const owner = createStableOrder<
    {
      id: string;
      position?: number;
      created?: number;
      activity?: number;
      status?: string;
    }
  >(() => {});
  const a = { id: "a", position: 0 }, b = { id: "b", position: 1 };
  const ids = (rows: Parameters<typeof owner.order>[0]) =>
    owner.order(rows, (row) => row).map((row) => row.id);
  assertEquals(ids([b, a]), ["a", "b"]);
  for (const status of ["working", "blocked", "finished", "none"]) {
    assertEquals(ids([{ ...b, activity: Date.now(), status }, a]), ["a", "b"]);
  }
  const c = { id: "c", position: 2 };
  assertEquals(ids([c, b, a]), ["a", "b", "c"]);
  const release = owner.hold();
  assertEquals(
    ids([{ ...c, position: 0 }, { ...a, position: 1 }, { ...b, position: 2 }]),
    ["c", "a", "b"],
  );
  release();
  assertEquals(ids([{ ...b, position: 2 }, { ...c, position: 0 }]), ["c", "b"]);
  owner.stop();
});

Deno.test("unpositioned identities retain creation/discovery order across refreshes and tracking", () => {
  const owner = createStableOrder<
    { id: string; created?: number; position?: number }
  >(() => {});
  const a = { id: "a", created: 1 }, b = { id: "b", created: 2 };
  const ids = (rows: Parameters<typeof owner.order>[0]) =>
    owner.order(rows, (row) => row).map((row) => row.id);
  assertEquals(ids([b, a]), ["a", "b"]);
  assertEquals(ids([b, { ...a, position: 5 }]), ["a", "b"]);
  assertEquals(ids([{ id: "older-arrival", created: 0 }, b, a]), [
    "a",
    "b",
    "older-arrival",
  ]);
  owner.stop();
});

Deno.test("a late source answer takes its saved place without moving known rows", () => {
  const owner = createStableOrder<
    { id: string; source: number; position?: number }
  >(() => {});
  const ids = (rows: Parameters<typeof owner.order>[0]) =>
    owner.order(rows, (row) => row).map((row) => row.id);
  const remote = [
    { id: "r1", source: 1, position: 1 },
    { id: "r0", source: 1, position: 0 },
  ];
  assertEquals(ids(remote), ["r0", "r1"]);
  const local = [
    { id: "l1", source: 0, position: 1 },
    { id: "l0", source: 0, position: 0 },
    { id: "found", source: 0 },
  ];
  assertEquals(ids([...remote, ...local]), ["l0", "l1", "found", "r0", "r1"]);
  // A later saved row of a known source lands at its place; unsaved rows append.
  assertEquals(
    ids([...remote, ...local, { id: "late", source: 0, position: 2 }, {
      id: "new",
      source: 1,
    }]),
    ["l0", "l1", "found", "late", "r0", "r1", "new"],
  );
  owner.stop();
});

Deno.test("an arrival during a hold appends and takes its saved place when the hold ends", () => {
  let changes = 0;
  const owner = createStableOrder<{ id: string; source: number }>(() =>
    changes++
  );
  const ids = (rows: Parameters<typeof owner.order>[0]) =>
    owner.order(rows, (row) => row).map((row) => row.id);
  const remote = { id: "remote", source: 1 },
    local = { id: "local", source: 0 };
  assertEquals(ids([remote]), ["remote"]);
  const release = owner.hold();
  assertEquals(ids([remote, local]), ["remote", "local"]);
  release();
  assertEquals(changes, 1);
  assertEquals(ids([remote, local]), ["local", "remote"]);
  owner.stop();
});

Deno.test("shared interaction holds retain departing targets and append arrivals without displacing them", () => {
  let changes = 0;
  const owner = createStableOrder<{ id: string; position: number }>(() =>
    changes++
  );
  const a = { id: "a", position: 0 },
    b = { id: "b", position: 1 },
    c = { id: "c", position: 2 };
  const ids = (rows: Parameters<typeof owner.order>[0]) =>
    owner.order(rows, (row) => row).map((row) => row.id);
  assertEquals(ids([a, b]), ["a", "b"]);
  const hover = owner.hold(), focus = owner.hold();
  assertEquals(ids([c, b]), ["a", "b", "c"]);
  hover();
  assertEquals(ids([c, b]), ["a", "b", "c"]);
  focus();
  assertEquals(ids([c, b]), ["b", "c"]);
  assertEquals(changes, 1);
  owner.stop();
});
