// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals, assertStrictEquals } from "@std/assert";
import { createDrafts, emptyDraft } from "../mod.ts";

Deno.test("dropping a draft retires captured writers without orphaning late completion", () => {
  const drafts = createDrafts(), write = drafts.writer("deleted");
  write({ ...emptyDraft(), input: "Old draft" });
  drafts.writer("retained")({ ...emptyDraft(), input: "Other draft" });
  drafts.drop("deleted");
  assertEquals(drafts.get("deleted"), emptyDraft());
  write({ ...emptyDraft(), input: "Late upload" });
  assertEquals(drafts.get("deleted"), emptyDraft());
  const replacement = drafts.writer("deleted");
  replacement({ ...emptyDraft(), input: "New lifetime" });
  write({ ...emptyDraft(), input: "Stale" });
  assertEquals(drafts.get("deleted").input, "New lifetime");
  assertEquals(drafts.get("retained").input, "Other draft");
});

Deno.test("empty writers keep read identity and current inspection cannot recreate a dropped lifetime", () => {
  const drafts = createDrafts();
  let changes = 0;
  const stop = drafts.subscribe(() => changes++);
  drafts.current("missing");
  drafts.drop("missing");
  assertEquals(changes, 0);
  const write = drafts.writer("empty");
  const empty = write((draft) => draft);
  assertStrictEquals(write((draft) => draft), empty);
  drafts.drop("empty");
  drafts.current("empty");
  const afterDrop = changes;
  drafts.drop("empty");
  assertEquals(changes, afterDrop);
  write({ ...emptyDraft(), input: "Retired history result" });
  assertEquals(drafts.get("empty"), emptyDraft());
  stop();
});
