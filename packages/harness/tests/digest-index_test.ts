// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals } from "@std/assert";
import { SessionIndex } from "@otk/harness";
import { test } from "../../../tests/support/resources.ts";

test("metadata and digest writes share identity without replacing live attention", () => {
  const index = new SessionIndex();
  const metadata = {
    id: "tstv1-one",
    directory: "/p",
    projectID: "p",
    title: "One",
    timeCreated: 1,
    timeUpdated: 2,
    archived: false,
    status: "idle" as const,
    attention: {
      permissions: 0,
      questions: 0,
      childPermissions: 0,
      childQuestions: 0,
    },
  };
  index.upsertMetadata(metadata);
  const enriched = {
    ...metadata,
    digest: { state: "ready" as const, revision: 99, turns: {} },
    deleted: { at: 1, how: "provider" as const },
  };
  index.upsertMetadata(enriched);
  assertEquals(index.get(metadata.id)?.deleted, undefined);
  assertEquals(index.get(metadata.id)?.digest, {
    state: "digesting",
    revision: 0,
    turns: {},
  });
  index.applyDigest({
    id: metadata.id,
    revision: 1,
    summary: { state: "ready", revision: 1, messageCount: 0 },
    turns: { upsert: {}, remove: [] },
    deleted: null,
  });
  index.upsertMetadata({
    ...metadata,
    status: "busy",
    title: "Live",
    attention: { ...metadata.attention, permissions: 1 },
  });
  index.applyDigest({
    id: metadata.id,
    revision: 2,
    summary: { state: "ready", revision: 2, messageCount: 1 },
    turns: { upsert: {}, remove: [] },
    deleted: null,
  });
  assertEquals(index.get(metadata.id)?.title, "Live");
  assertEquals(index.get(metadata.id)?.status, "busy");
  assertEquals(index.get(metadata.id)?.attention.permissions, 1);
  assertEquals(index.get(metadata.id)?.digest.messageCount, 1);
  index.applyDigest({
    id: metadata.id,
    revision: 1,
    summary: { state: "ready", revision: 1, messageCount: 0 },
    turns: { upsert: {}, remove: [] },
    deleted: null,
  });
  assertEquals(index.get(metadata.id)?.digest.messageCount, 1);
  index.resetMetadata([]);
  assertEquals(index.get(metadata.id)?.title, "Live");
});
test("unleased turn detail stays at its owner; a lease loads it and release evicts it", () => {
  const index = new SessionIndex();
  const loads: string[] = [];
  index.turnLoader = (id) => loads.push(id);
  const metadata = (id: string) => ({
    id,
    directory: "/p",
    projectID: "p",
    title: id,
    timeCreated: 1,
    timeUpdated: 2,
    archived: false,
    status: "idle" as const,
    attention: {
      permissions: 0,
      questions: 0,
      childPermissions: 0,
      childQuestions: 0,
    },
  });
  const usage = { state: "pending" as const };
  const delta = (id: string, revision: number, turn: string) => ({
    id,
    revision,
    summary: { state: "ready" as const, revision },
    turns: { upsert: { [turn]: usage }, remove: [] },
    deleted: null,
  });
  index.upsertMetadata(metadata("one"));
  index.upsertMetadata(metadata("two"));
  for (let turn = 0; turn < 50; turn++) {
    assertEquals(index.applyDigest(delta("one", turn + 1, `t${turn}`)), true);
  }
  assertEquals(index.get("one")?.digest.turns, {});
  assertEquals(index.get("one")?.digest.revision, 50);
  assertEquals(
    index.applyDigest({
      ...delta("one", 51, "t0"),
      turns: { upsert: {}, remove: ["t0"] },
    }),
    true,
  );
  const release = index.retainTurns("one");
  const again = index.retainTurns("one");
  assertEquals(loads, ["one"]);
  // The owner's keyed replay at the current revision fills the leased entry.
  index.applyDigest(delta("one", 51, "t1"));
  index.applyDigest(delta("one", 52, "t2"));
  assertEquals(Object.keys(index.get("one")!.digest.turns), ["t1", "t2"]);
  assertEquals(index.get("two")?.digest.turns, {});
  release();
  assertEquals(Object.keys(index.get("one")!.digest.turns), ["t1", "t2"]);
  again();
  again();
  assertEquals(index.get("one")?.digest.turns, {});
  assertEquals(index.get("one")?.digest.revision, 52);
  const owned = new SessionIndex();
  owned.upsertMetadata(metadata("one"));
  owned.applyDigest(delta("one", 1, "t0"));
  assertEquals(Object.keys(owned.get("one")!.digest.turns), ["t0"]);
});
