// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals } from "@std/assert";
import { SessionIndex } from "@otk/harness";
import type { IndexEntry } from "@otk/protocol";

Deno.test("session index owns metadata and topology across copy edits, late parents, removal and cycles", () => {
  const index = new SessionIndex();
  const entry = (id: string, parentID?: string): IndexEntry => ({
    id,
    parentID,
    projectID: "p",
    directory: "/p",
    title: id,
    timeCreated: 1,
    timeUpdated: 1,
    archived: false,
    status: "idle",
    attention: {
      permissions: 0,
      questions: 0,
      childPermissions: 0,
      childQuestions: 0,
    },
  });
  index.reset([entry("child", "late"), entry("other")]);
  assertEquals([...index.descendants("late")], ["late", "child"]);
  const copy = index.get("child")!;
  copy.parentID = "other";
  assertEquals(index.get("child")!.parentID, "late");
  index.upsert(copy);
  assertEquals([...index.descendants("late")], ["late"]);
  assertEquals([...index.descendants("other")], ["other", "child"]);
  index.remove("other");
  index.upsert(entry("other", "child"));
  assertEquals([...index.descendants("other")], ["other", "child"]);
  assertEquals(index.ancestors("child"), ["other"]);
  const values = [...index.values()];
  values[0].title = "detached";
  assertEquals(index.get("child")!.title, "child");
});
