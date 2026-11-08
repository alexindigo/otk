// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals, assertStrictEquals, assertThrows } from "@std/assert";
import type { IndexEntry } from "@otk/protocol";
import { IndexStore } from "../../../core/index/store.ts";

Deno.test("index observers borrow immutable authority without copying retained history", () => {
  const index = new IndexStore();
  const observations: { entry: IndexEntry; previous?: IndexEntry }[] = [];
  index.observe((entry, previous) => observations.push({ entry, previous }));
  index.observe((entry) => {
    assertThrows(() => {
      entry.attention.permissions = 99;
    }, TypeError);
    assertStrictEquals(entry, index.snapshotEntry(entry.id));
  });
  const metadata = {
    id: "tstv1-one",
    projectID: "p",
    directory: "/p",
    title: "Before",
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
  index.upsertMetadata({ ...metadata, title: "After" });
  assertStrictEquals(observations[1].previous, observations[0].entry);
  assertStrictEquals(
    observations[1].entry.digest,
    observations[0].entry.digest,
  );
  assertEquals(observations[0].entry.title, "Before");
  assertEquals(observations[1].entry.title, "After");
  assertEquals(index.get(metadata.id)!.attention.permissions, 0);
});
