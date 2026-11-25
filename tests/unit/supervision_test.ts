// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals } from "@std/assert";
import { SessionSupervision } from "../../core/index/supervision.ts";
import type { IndexMetadata, SupervisionEvidence } from "@otk/protocol";
import { createEntityStateStore, inboxProjects, lamp } from "@otk/client";
import { ProjectSummaries } from "../../core/index/project-summaries.ts";

function entry(
  activity?: SupervisionEvidence,
  parentID?: string,
): IndexMetadata {
  return {
    id: "opcv2-ses_fixture",
    parentID,
    directory: "/fixture",
    projectID: "repo",
    title: "Fixture",
    timeCreated: 1,
    timeUpdated: 2,
    archived: false,
    status: "busy",
    activityAuthority: "current",
    activity,
    attention: {
      permissions: 0,
      questions: 0,
      childPermissions: 0,
      childQuestions: 0,
    },
  };
}
Deno.test("supervision has no activity without positive evidence, regardless of legacy status", () => {
  const owner = new SessionSupervision();
  assertEquals(owner.session(entry(), 0).state, "none");
  assertEquals(
    owner.session(entry({ work: { keys: ["run-1"], fresh: true } }), 0).state,
    "working",
  );
  assertEquals(
    owner.session(entry({ work: { keys: ["run-1"], fresh: false } }), 0).state,
    "none",
  );
});
Deno.test("supervision distinguishes fresh inputs and terminal evidence; parents have only their own state", () => {
  const owner = new SessionSupervision();
  const row = entry({
    inputs: { keys: ["permission-1"], fresh: true },
    terminal: 100,
  });
  assertEquals(owner.session(row, 0).state, "needsYou");
  assertEquals(
    owner.session({
      ...row,
      activity: { inputs: { keys: ["permission-1"], fresh: false } },
    }, 0).state,
    "none",
  );
  const parent = {
    ...entry(),
    attention: {
      permissions: 0,
      questions: 0,
      childPermissions: 1,
      childQuestions: 1,
    },
  };
  assertEquals(owner.session(parent, 0).state, "none");
  assertEquals(
    owner.session(entry({ terminal: 100 }, "opcv2-ses_parent"), 0).state,
    "finishedUnseen",
  );
  assertEquals(owner.session(entry({ terminal: 100 }), 100).state, "none");
  assertEquals(
    owner.session(entry({ terminal: 200 }), 100).state,
    "finishedUnseen",
  );
});

Deno.test("scalar indexing cannot erase a project lamp and children retain unseen finishes", () => {
  const summaries = new ProjectSummaries(
    () => ({ seen: 0, finish: 100 }),
    () => {},
  );
  summaries.authority("current");
  summaries.seed([{
    directory: "/fixture",
    hasSessions: true,
    sessionCount: 1,
    lastActivity: 2,
    authority: "current",
  }]);
  summaries.entry(entry({ terminal: 100 }, "opcv2-ses_parent"));
  const summary = summaries.values.get("/fixture")!;
  assertEquals(summary.status, "finished");
  const rows = inboxProjects([], {
    projects: [],
    tasks: [],
    seen: {},
    finishes: {},
    pathTemplates: [],
    summaries: { "/fixture": summary },
    entities: Object.fromEntries(summaries.states.values()),
  }, 0);
  assertEquals(rows[0]?.status, "finished");
});
Deno.test("client consumers never reconstruct activity from metadata or completion bookkeeping", () => {
  const row = entry({ work: { keys: ["run"], fresh: true } });
  const inbox = { finishes: { [row.id]: 100 } };
  const key = `session:${row.id}`;
  let values = {};
  const replica = createEntityStateStore({ read: () => values });
  assertEquals(lamp(replica, key), "none");
  values = {
    [key]: {
      kind: "session",
      id: row.id,
      state: "finished",
      previous: "none",
      counts: { blocked: 0, working: 0, finished: 1, unseen: 1 },
    },
  };
  assertEquals(inbox.finishes[row.id], 100);
  assertEquals(lamp(replica, key), "finished");
  replica.stop();
});
Deno.test("unacknowledged helper failure owns needs-you lamps and the project rollup", () => {
  let seen = 0;
  const owner = new SessionSupervision();
  const row = entry({
    terminal: 100,
    outcome: "failed",
    delivered: {
      parentID: "opcv2-ses_parent",
      receipt: "result",
      terminal: 100,
    },
  }, "opcv2-ses_parent");
  const summaries = new ProjectSummaries(
    () => ({ seen, finish: 100 }),
    () => {},
    () => {},
    owner,
  );
  summaries.entry(row);
  assertEquals(owner.session(row, seen).state, "needsYou");
  assertEquals(summaries.values.get("/fixture")?.status, "blocked");
  seen = 100;
  summaries.mark(row.id);
  assertEquals(owner.session(row, seen).state, "none");
  assertEquals(summaries.values.get("/fixture")?.status, "none");
});
