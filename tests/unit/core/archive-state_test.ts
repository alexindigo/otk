// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals } from "@std/assert";
import {
  entityKey,
  type IndexMetadata,
  UNKNOWN_REPOSITORY,
} from "@otk/protocol";
import { EntityStates } from "../../../core/index/entity-states.ts";
import { SessionSupervision } from "../../../core/index/supervision.ts";
import { ManualClock } from "../../support/manual-clock.ts";

Deno.test("archive state follows the unchanged C3 placement, checkout deltas, acknowledgement and repository moves", () => {
  const clock = new ManualClock();
  const rows = new Map<string, IndexMetadata>();
  const states = new EntityStates(
    new SessionSupervision(),
    {
      getMetadata: (id) => rows.get(id),
      ancestors: () => [],
      descendants: () => new Set(),
    },
    () => {},
    clock,
  );
  const row: IndexMetadata = {
    id: "s",
    directory: "/removed",
    projectID: "repo",
    title: "Session",
    archived: false,
    status: "idle",
    timeCreated: 1,
    timeUpdated: 1,
    attention: {
      permissions: 0,
      questions: 0,
      childPermissions: 0,
      childQuestions: 0,
    },
  };
  const facts = {
    directory: "/removed",
    archived: true,
    availability: "removed" as const,
    topology: {
      repoID: "repo",
      canonicalRoot: "/main",
      leafDirectory: "/removed",
      parentDirectory: "/main",
    },
  };
  const put = (activity: IndexMetadata["activity"], seen = 0) => {
    const next = { ...row, activity };
    rows.set(row.id, next);
    states.session(next, seen);
  };
  const archive = (id = "repo") => states.get(entityKey("archive", id));
  put({ terminal: 10 });
  states.member(row.id, row.directory);
  states.checkout(row.directory, 0);
  states.placement(facts);
  assertEquals(archive()?.state, "finished");
  assertEquals(archive()?.counts.unseen, 1);
  put({ work: { keys: ["run"], fresh: true }, terminal: 10 });
  assertEquals(archive()?.state, "none"); // C3: working removed checkouts remain live.
  put({ permissions: { keys: ["p"], fresh: true }, terminal: 10 });
  clock.runNext();
  assertEquals(archive()?.state, "none"); // C3: blocked removed checkouts remain live.
  put({ terminal: 20 });
  assertEquals(archive()?.state, "finished");
  assertEquals(archive()?.counts.unseen, 1);
  put({ terminal: 20 }, 20);
  assertEquals(archive()?.counts.unseen, 0);
  assertEquals(archive()?.state, "none");
  states.placement({
    ...facts,
    topology: { ...facts.topology, repoID: "moved" },
  });
  put({ terminal: 30 });
  assertEquals(archive()?.counts.unseen, 0);
  assertEquals(archive("moved")?.counts.unseen, 1);
  states.placement({
    ...facts,
    topology: { ...facts.topology, canonicalRoot: UNKNOWN_REPOSITORY },
  });
  put({ work: { keys: ["run"], fresh: true }, terminal: 30 });
  assertEquals(archive(UNKNOWN_REPOSITORY)?.state, "working"); // No fabricated live parent.
  states.checkout(row.directory, 1);
  assertEquals(archive(UNKNOWN_REPOSITORY)?.state, "blocked");
  states.drop(row.directory);
  assertEquals(archive(UNKNOWN_REPOSITORY)?.state, "none");
  assertEquals(archive(UNKNOWN_REPOSITORY)?.counts.working, 0);
});
