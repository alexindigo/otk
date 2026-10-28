// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals, assertStrictEquals, assertThrows } from "@std/assert";
import { SessionIndex } from "@otk/harness";
import type { IndexEntry } from "@otk/protocol";

Deno.test("borrowed index snapshots are immutable and stable across field-owned replacements", () => {
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
  const read = Reflect.get(index, "snapshotEntries");
  assertEquals(typeof read, "function");
  const before = Reflect.apply(read, index, []) as IndexEntry[];
  const again = Reflect.apply(read, index, []) as IndexEntry[];
  assertStrictEquals(
    before[0],
    again[0],
    "Unchanged snapshots must borrow the same owned immutable entry",
  );
  assertThrows(() => {
    before[0].digest.revision = 99;
  }, TypeError);
  assertThrows(() => {
    before[0].attention.permissions = 99;
  }, TypeError);
  assertThrows(() => {
    before.push(before[0]);
  }, TypeError);
  index.applyDigest({
    id: metadata.id,
    revision: 1,
    summary: { state: "ready", revision: 1, messageCount: 0 },
    turns: { upsert: {}, remove: [] },
    deleted: { at: 3, how: "provider" },
  });
  index.upsertMetadata({ ...metadata, title: "New title" });
  const after = Reflect.apply(read, index, []) as IndexEntry[];
  assertEquals(before[0].title, "One");
  assertEquals(before[0].digest.revision, 0);
  assertEquals(before[0].deleted, undefined);
  assertEquals(after[0].title, "New title");
  assertEquals(after[0].digest.revision, 1);
  assertEquals(after[0].deleted?.how, "provider");
  // Existing detached mutable reads retain their contract.
  const copy = index.get(metadata.id)!;
  copy.digest.revision = 20;
  assertEquals(index.get(metadata.id)!.digest.revision, 1);
  const getMetadata = Reflect.get(index, "getMetadata");
  assertEquals(typeof getMetadata, "function");
  const clone = globalThis.structuredClone;
  let historyReads = 0;
  globalThis.structuredClone = (value, options) => {
    if (value && typeof value === "object" && "digest" in value) historyReads++;
    return clone(value, options);
  };
  try {
    const live = Reflect.apply(getMetadata, index, [metadata.id]) as Omit<
      IndexEntry,
      "digest"
    >;
    assertEquals("digest" in live, false);
    assertEquals(live.title, "New title");
    assertEquals(live.deleted?.how, "provider");
    live.attention.permissions = 10;
    live.deleted!.at = 99;
    index.ancestors(metadata.id);
    assertEquals(
      historyReads,
      0,
      "Metadata/topology reads cannot copy turn history",
    );
    assertEquals(Reflect.apply(getMetadata, index, ["missing"]), undefined);
  } finally {
    globalThis.structuredClone = clone;
  }
  assertEquals(index.get(metadata.id)!.attention.permissions, 0);
  assertEquals(index.get(metadata.id)!.deleted?.at, 3);
});
