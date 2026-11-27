// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals } from "@std/assert";
import {
  createAttentionProjection,
  createIndex,
  NotificationTriggers,
  presentedEntity,
} from "@otk/client";
import type { EntityState, IndexEntry } from "@otk/protocol";

Deno.test("independent plain consumer borrows keyed attention deltas without a notification index", () => {
  const index = createIndex(), notes: string[] = [];
  const publications = new Map<string, EntityState>();
  const owner = createAttentionProjection({
    entry: (id) => index.get("external", id),
    ids: () => index.ids("external"),
    entity: (id) => publications.get(id),
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
    activity: { work: { keys: ["external-run"], fresh: true } },
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
    ops: [{
      op: "upsert",
      entry: { ...entry, status: "idle", activity: undefined },
    }],
  });
  owner.update(index.changes("external")!.ids);
  // A status transition is not terminal evidence (decision 6).
  assertEquals(notes, []);
  index.receive("external", {
    t: "index.patch",
    rev: 2,
    ops: [{
      op: "upsert",
      entry: { ...entry, status: "idle", activity: { terminal: 2 } },
    }],
  });
  owner.update(index.changes("external")!.ids);
  assertEquals(notes, [], "An index terminal is not a published live edge");
  publications.set(entry.id, {
    ...presentedEntity("session", entry.id, "finished", true),
    terminal: 2,
    terminalOrigin: "live",
  });
  owner.update([entry.id]);
  assertEquals(notes, ["External job"]);
  release();
  trigger.reset("external");
});
