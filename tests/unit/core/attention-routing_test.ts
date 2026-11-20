// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals, assertStrictEquals } from "@std/assert";
import type { IndexEntry } from "@otk/protocol";
import { RequestAttention } from "../../../core/features/request-attention.ts";
import type { IndexStore } from "../../../core/index/store.ts";

Deno.test("WP5 cross-project attention retains only request identities for shared grace", () => {
  const entry: IndexEntry = {
    id: "pending",
    title: "Pending",
    directory: "/pending",
    projectID: "p",
    timeCreated: 1,
    timeUpdated: 2,
    status: "busy",
    archived: false,
    digest: { state: "digesting", revision: 0, turns: {} },
    attention: {
      permissions: 1,
      questions: 1,
      childPermissions: 0,
      childQuestions: 0,
    },
    activity: {
      permissions: { keys: ["permission"], fresh: true },
      inputs: { keys: ["question"], fresh: true },
      work: { keys: ["private-work"], fresh: true },
      terminal: 42,
      outcome: "succeeded",
    },
  };
  let ancestors: string[] = [];
  const owner = new RequestAttention({
    snapshotEntries: () => [entry],
    observe: () => () => {},
    observeRemoval: () => () => {},
    getMetadata: () => entry,
    ancestors: () => ancestors,
  } as unknown as IndexStore, () => false);
  try {
    owner.keys();
    const view = { epoch: 1, directory: "/other", crumbs: [], rows: [] };
    const routed = owner.project(entry, view);
    assertEquals(routed.activity, {
      permissions: entry.activity!.permissions,
      inputs: entry.activity!.inputs,
    });
    assertEquals(routed.status, "idle");
    assertEquals(routed.timeUpdated, 0);
    assertStrictEquals(
      owner.project(entry, { ...view, directory: "/pending" }),
      entry,
    );
    ancestors = ["open"];
    assertStrictEquals(
      owner.project(entry, { ...view, selected: "open" }),
      entry,
    );
    entry.activity!.work!.fresh = false;
    assertEquals(
      owner.project(entry, { ...view, selected: "open" }).activity?.work,
      undefined,
    );
    entry.activity!.work = { fresh: true, keys: [] };
    assertEquals(
      owner.project(entry, { ...view, selected: "open" }).activity?.work,
      undefined,
    );
  } finally {
    owner.close();
  }
});
