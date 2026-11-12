// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals } from "@std/assert";
import { createInbox } from "../inbox.ts";
import { createProjectProjection } from "../project-projection.ts";
import type { ProjectSummary } from "@otk/protocol";
import type { MergedMetadata } from "../index.ts";

Deno.test("project rows consume server summaries without any session entries", () => {
  const inbox = createInbox({
    call: () => Promise.reject(new Error("No reads expected")),
  });
  const rows = createProjectProjection({ entry: () => undefined });
  inbox.observeChanges((changes) => rows.inbox(inbox.state.inbox, changes));
  const summary: ProjectSummary = {
    directory: "/other",
    status: "working",
    sessionCount: 7,
    unseenCount: 0,
    lastActivity: 42,
    authority: "current",
  };
  inbox.receive({
    t: "inbox.snapshot",
    generation: "g",
    revision: 0,
    summaryRevision: 0,
    inbox: {
      projects: [],
      tasks: [],
      seen: {},
      finishes: {},
      pathTemplates: [],
      summaries: { "/other": summary },
    },
  });
  assertEquals(rows.row("/other", 0)?.status, "working");
  assertEquals(rows.row("/other", 0)?.sessionCount, 7);
  assertEquals(rows.row("/other", 0)?.sessionIDs, "");
  inbox.receive({
    t: "inbox.summaries",
    generation: "g",
    from: 0,
    revision: 1,
    summaries: [{ ...summary, status: "finished", unseenCount: 1 }],
  });
  assertEquals(rows.row("/other", 0)?.status, "finished");
  assertEquals(rows.row("/other", 0)?.unread, true);
  inbox.receive({
    t: "inbox.summaries",
    generation: "g",
    from: 0,
    revision: 1,
    summaries: [summary],
  });
  assertEquals(
    rows.row("/other", 0)?.status,
    "finished",
    "Duplicate summary regressed newer authority",
  );
  inbox.receive({
    t: "inbox.summaries",
    generation: "g",
    from: 1,
    revision: 2,
    summaries: [],
    remove: ["/other"],
  });
  assertEquals(rows.row("/other", 0), undefined);
  inbox.stop();
});

Deno.test("project lamps consume server supervision independently of metadata and population readiness", () => {
  let entry: MergedMetadata = {
    id: "tstv1-retained",
    directory: "/retained",
    sidecarId: "local",
    title: "Retained",
    projectID: "p",
    parentID: undefined,
    status: "idle",
    activityAuthority: "unknown",
    archived: false,
    timeCreated: 1,
    timeUpdated: 2,
    attention: {
      permissions: 0,
      questions: 0,
      childPermissions: 0,
      childQuestions: 0,
    },
  };
  const model = createInbox({
    call: () => Promise.reject(new Error("No reads expected")),
  });
  const rows = createProjectProjection({ entry: () => entry });
  model.observeChanges((changes) => rows.inbox(model.state.inbox, changes));
  rows.update([entry.id]);
  const summary: ProjectSummary = {
    directory: entry.directory,
    status: null,
    sessionCount: null,
    unseenCount: null,
    lastActivity: null,
    authority: "unknown",
  };
  model.receive({
    t: "inbox.snapshot",
    generation: "g",
    revision: 0,
    summaryRevision: 0,
    inbox: {
      projects: [],
      tasks: [],
      seen: {},
      finishes: {},
      pathTemplates: [],
      summaries: { [entry.directory]: summary },
    },
  });
  assertEquals(rows.row(entry.directory, 0)?.sessionCount, null);
  assertEquals(rows.row(entry.directory, 0)?.unread, false);
  entry = { ...entry, status: "busy", activityAuthority: "current" };
  rows.update([entry.id]);
  assertEquals(rows.row(entry.directory, 0)?.status, "none");
  model.receive({
    t: "inbox.patch",
    generation: "g",
    from: 0,
    revision: 1,
    ops: [{ op: "finish", sessionID: entry.id, time: 3 }],
  });
  entry = { ...entry, status: "idle" };
  rows.update([entry.id]);
  assertEquals(rows.row(entry.directory, 0)?.status, "none");
  assertEquals(rows.row(entry.directory, 0)?.unread, true);
  assertEquals(rows.row(entry.directory, 0)?.summary?.unseenCount, null);
  model.receive({
    t: "inbox.patch",
    generation: "g",
    from: 1,
    revision: 2,
    ops: [{ op: "seen", sessionID: entry.id, time: 4 }],
  });
  assertEquals(
    rows.row(entry.directory, 0)?.unread,
    false,
    "An unknown population never erases a known acknowledgement",
  );
  model.receive({
    t: "inbox.summaries",
    generation: "g",
    from: 0,
    revision: 1,
    summaries: [{
      ...summary,
      status: "none",
      sessionCount: 7,
      unseenCount: 0,
      lastActivity: 42,
      authority: "current",
    }],
  });
  entry = { ...entry, status: "busy" };
  rows.update([entry.id]);
  assertEquals(
    rows.row(entry.directory, 0)?.status,
    "none",
    "Server authority never borrows raw session status",
  );
  assertEquals(rows.row(entry.directory, 0)?.sessionCount, 7);
  model.stop();
});

Deno.test("known idle authority renders without session metadata or known population counts", () => {
  const rows = createProjectProjection({ entry: () => undefined });
  rows.inbox({
    projects: [],
    tasks: [],
    seen: {},
    finishes: {},
    pathTemplates: [],
    summaries: {
      "/idle": {
        directory: "/idle",
        status: "none",
        authority: "current",
        sessionCount: null,
        unseenCount: null,
        lastActivity: null,
      },
    },
  });
  assertEquals(rows.row("/idle", 0)?.status, "none");
  assertEquals(rows.row("/idle", 0)?.sessionCount, null);
  assertEquals(rows.row("/idle", 0)?.unread, false);
  assertEquals(rows.row("/idle", 0)?.source, "index");
});
