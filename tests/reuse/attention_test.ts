// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals } from "@std/assert";
import {
  createAttentionProjection,
  createIndex,
  NotificationTriggers,
} from "@otk/client";
import type { IndexEntry } from "@otk/protocol";

Deno.test("independent plain consumer borrows keyed attention deltas without a notification index", () => {
  const index = createIndex(), notes: string[] = [];
  const owner = createAttentionProjection({
    entry: (id) => index.get("external", id),
    ids: () => index.ids("external"),
    children: (id) => index.children("external", id),
  });
  const trigger = new NotificationTriggers(
    (note) => notes.push(note.body!),
    () => {},
  );
  const release = owner.subscribe((change) =>
    trigger.entriesChanged("external", change)
  );
  const entry: IndexEntry = {
    id: "tstv1-job",
    directory: "/external",
    projectID: "external",
    title: "External job",
    status: "busy",
    archived: false,
    timeCreated: 1,
    timeUpdated: 1,
    attention: {
      permissions: 0,
      childPermissions: 0,
      questions: 0,
      childQuestions: 0,
    },
    digest: { state: "digesting", revision: 0, turns: {} },
  };
  index.receive("external", { t: "index.snapshot", rev: 0, entries: [entry] });
  owner.update(index.changes("external")!.ids, true);
  assertEquals(notes, []);
  index.receive("external", {
    t: "index.patch",
    rev: 1,
    ops: [{ op: "upsert", entry: { ...entry, status: "idle" } }],
  });
  owner.update(index.changes("external")!.ids);
  assertEquals(notes, ["External job"]);
  release();
  trigger.reset("external");
});
