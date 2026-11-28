// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals } from "@std/assert";
import { createInbox, inboxProjects } from "../inbox.ts";
import { createProjectProjection } from "../project-projection.ts";
import {
  entityKey,
  type EntityState,
  type InboxSnapshot,
  type ProjectSummary,
} from "@otk/protocol";
import { createEntityStateStore, presentedEntity } from "../entity-state.ts";
import { age } from "../format.ts";
import { sidebarTimer } from "../sidebar-timer.ts";
import type { MergedMetadata } from "../index.ts";
import { shellEntry } from "./shell-fixture.ts";

Deno.test("D79: run and attention timers format the same duration identically", () => {
  const start = 1234;
  const project = {
    directory: "/p",
    added: true,
    inactive: false,
    lastVisit: start,
  };
  for (
    const [ms, text] of [
      [30_800, "now"],
      [2 * 60_000, "2m"],
      [3_600_000 + 30_800, "1h"],
      [3_600_000 + 2 * 60_000 + 30_800, "1h 2m"],
    ] as const
  ) {
    const run = sidebarTimer("working", start, start + ms)!;
    const attention = sidebarTimer("finished", undefined, start + ms, project)!;
    assertEquals([run.kind, attention.kind], ["run", "attention"]);
    assertEquals(run.time.text, attention.time.text);
    assertEquals(run.time.parts, attention.time.parts);
    assertEquals(run.time.text, text);
  }
});

Deno.test("D79: project timer selects the clock and tone from the rollup", () => {
  for (
    const [status, kind, tone] of [
      ["working", "run", "muted"],
      ["blocked", "attention", "default"],
      ["finished", "attention", "default"],
      ["none", "visit", "default"],
      ["dependencies", "visit", "default"],
    ] as const
  ) {
    const directory = "/p";
    const inbox: InboxSnapshot = {
      projects: [{ directory, added: true, inactive: false, lastVisit: 0 }],
      tasks: [],
      seen: {},
      finishes: {},
      pathTemplates: [],
      discovered: [directory],
      entities: {
        [entityKey("project", directory)]: {
          ...presentedEntity("project", directory, status),
          ...{ runStartedAt: 90_000 },
        },
      },
    };
    const store = createEntityStateStore({ read: () => inbox.entities });
    const projection = createProjectProjection({
      entry: () => undefined,
      entities: () => store,
    });
    const check = (now: number, expected: unknown) => {
      const row = projection.row(directory, now)!;
      assertEquals(row.status, status);
      assertEquals(Reflect.get(row, "timer"), expected, status);
      assertEquals(
        Reflect.get(inboxProjects([], inbox, now)[0], "timer"),
        expected,
        status,
      );
    };
    if (status === "none") {
      // Inactive grey rows freeze the age at deactivation, not at render time.
      inbox.projects[0].inactive = true;
      inbox.projects[0].inactiveAt = 60_000;
      projection.inbox(inbox);
      check(120_000, { kind, tone, time: age(0, 60_000, "inactive") });
      inbox.projects[0] = { ...inbox.projects[0], inactive: false };
    }
    projection.inbox(inbox);
    for (const now of [120_000, 150_000]) {
      check(now, {
        kind,
        tone,
        time: status === "working" ? age(90_000, now, "run") : age(0, now),
      });
    }
    if (status === "none") {
      const now = 3_720_000;
      check(now, { kind, tone, time: age(0, now) });
      assertEquals(projection.row(directory, now)?.timer?.time.text, "1h");
    }
  }
});

Deno.test("archive is independent of inactive policy; only live attention escapes it", () => {
  for (const inactive of [false, true]) {
    for (const status of ["working", "blocked", "finished", "none"] as const) {
      const inbox: InboxSnapshot = {
        projects: [{
          directory: "/tree",
          added: true,
          inactive,
          lastVisit: 0,
        }],
        tasks: [],
        seen: {},
        finishes: {},
        pathTemplates: [],
        summaries: {
          "/tree": {
            directory: "/tree",
            status,
            hasSessions: true,
            sessionCount: 1,
            unseenCount: status === "finished" ? 1 : 0,
            lastActivity: 1,
            authority: "current",
            availability: "removed",
            ...{ archived: true },
            topology: {
              repoID: "repo",
              canonicalRoot: "/repo",
              leafDirectory: "/tree",
              parentDirectory: "/repo",
            },
          },
        },
      };
      inbox.entities = {
        "project:/tree": presentedEntity(
          "project",
          "/tree",
          status,
          status === "finished",
        ),
      };
      const store = createEntityStateStore({ read: () => inbox.entities });
      const rows = createProjectProjection({
        entry: () => undefined,
        entities: () => store,
      });
      rows.inbox(inbox);
      for (
        const row of [rows.row("/tree", 0)!, inboxProjects([], inbox, 0)[0]]
      ) {
        assertEquals("archived" in row && row.archived, true);
        assertEquals(
          row.group,
          status === "working" || status === "blocked" ? "active" : "archived",
        );
        assertEquals(
          row.section,
          status === "working" || status === "blocked" ? "live" : "archived",
        );
        assertEquals(row.annotation, "removed");
        assertEquals(row.inactive, inactive && status === "none");
      }
    }
  }
});

Deno.test("INV-A records have identical section and annotation in both projections", () => {
  const root = "/home/user/Projects/atmosphera";
  const repoID = "c427c4a79e5b39bebe7cdd8db416e53f7fef36f7";
  const records = [["configqml", 2], ["edge-scroll", 2], ["hot-corners", 1], [
    "locker",
    3,
  ]] as const;
  for (const inactive of [false, true]) {
    for (const status of ["finished", "working", "blocked", "none"] as const) {
      const inbox: InboxSnapshot = {
        projects: [],
        tasks: [],
        seen: {},
        finishes: {},
        pathTemplates: [],
        summaries: {},
      };
      for (const [name, count] of records) {
        const directory = root + "." + name;
        inbox.projects.push({
          directory,
          inactive,
          added: true,
          lastVisit: 1,
        });
        inbox.summaries![directory] = {
          directory,
          status,
          hasSessions: true,
          sessionCount: count,
          unseenCount: status === "none" ? 0 : count,
          lastActivity: 1,
          authority: "current",
          availability: "removed",
          archived: true,
          memberships: [{
            source: "opencode-v2:/home/user/.local/share/opencode/opencode.db",
            repoID,
            directory,
            leafDirectory: directory,
            kind: "worktree",
            inventory: "current",
            availability: "removed",
          }],
          topology: {
            repoID,
            canonicalRoot: root,
            leafDirectory: directory,
            parentDirectory: root,
          },
        };
      }
      inbox.entities = Object.fromEntries(
        Object.keys(inbox.summaries ?? {}).map((
          id,
        ) => [
          entityKey("project", id),
          presentedEntity("project", id, status, status === "finished"),
        ]),
      );
      const store = createEntityStateStore({ read: () => inbox.entities });
      const projection = createProjectProjection({
        entry: () => undefined,
        entities: () => store,
      });
      projection.inbox(inbox);
      const other = inboxProjects([], inbox, 2);
      for (const row of other) {
        const keyed = projection.row(row.directory, 2)!;
        assertEquals(
          row.group,
          status === "working" || status === "blocked" ? "active" : "archived",
        );
        assertEquals([keyed.section, keyed.annotation, keyed.group], [
          row.section,
          row.annotation,
          row.group,
        ]);
        assertEquals(
          row.section,
          status === "working" || status === "blocked" ? "live" : "archived",
        );
        assertEquals(row.annotation, "removed");
      }
    }
  }
});

Deno.test("deleted family members cannot keep project unread contributions", () => {
  for (const tracked of [false, true]) {
    for (const hasSummary of [false, true]) {
      const parent = { ...shellEntry("parent"), sidecarId: "s" };
      let child: MergedMetadata = {
        ...shellEntry("child", "/p", parent.id),
        sidecarId: "s",
      };
      const summary: ProjectSummary = {
        directory: "/p",
        status: "none",
        sessionCount: 1,
        unseenCount: 0,
        lastActivity: 1,
        authority: "current",
      };
      const inbox: InboxSnapshot = {
        projects: tracked
          ? [{
            directory: "/p",
            added: true,
            inactive: false,
            lastVisit: 0,
          }]
          : [],
        tasks: [],
        seen: {},
        finishes: { [child.id]: 10 },
        supervision: {
          [child.id]: { state: "finishedUnseen", terminal: 10, unseen: true },
        },
        pathTemplates: [],
        ...(hasSummary ? { summaries: { "/p": summary } } : {}),
      };
      // Decision 62: which members count is the server owner's rule
      // (tests/unit/core/entity-states_test.ts); rows show its project state.
      const entities: Record<string, EntityState> = inbox.entities = {};
      const store = createEntityStateStore({ read: () => entities });
      const rows = createProjectProjection({
        entry: (id) => id === parent.id ? parent : child,
        entities: () => store,
      });
      rows.inbox(inbox);
      rows.update([parent.id, child.id]);
      const check = (expected: boolean) => {
        const key = entityKey("project", "/p");
        entities[key] = presentedEntity(
          "project",
          "/p",
          expected ? "finished" : "none",
          expected,
        );
        rows.entities([key]);
        assertEquals(rows.row("/p", 0)?.unread, expected);
        assertEquals(
          inboxProjects([parent, child], inbox, 0)[0].unread,
          expected,
        );
      };
      check(true);
      child = { ...child, deleted: { at: 11, how: "provider" } };
      rows.update([child.id]);
      check(false);
      inbox.finishes[child.id] = 12;
      rows.inbox(inbox, {
        baseline: false,
        projects: [],
        sessions: [child.id],
        tasks: false,
        discovery: false,
      });
      check(false);
      child = { ...child, deleted: undefined };
      rows.update([child.id]);
      check(true);
      inbox.seen[child.id] = 12;
      inbox.supervision![child.id] = {
        state: "none",
        terminal: 12,
        unseen: false,
      };
      rows.inbox(inbox, {
        baseline: false,
        projects: [],
        sessions: [child.id],
        tasks: false,
        discovery: false,
      });
      check(false);
    }
  }
});

Deno.test("project rows consume entity state and inventory summaries without any session entries", () => {
  const inbox = createInbox({
    call: () => Promise.reject(new Error("No reads expected")),
  });
  const rows = createProjectProjection({
    entry: () => undefined,
    entities: () => inbox.entities,
  });
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
      entities: {
        "project:/other": presentedEntity("project", "/other", "working"),
      },
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
  assertEquals(
    rows.row("/other", 0)?.status,
    "working",
    "summary cannot change the lamp",
  );
  inbox.receive({
    t: "inbox.patch",
    generation: "g",
    from: 0,
    revision: 1,
    ops: [{
      op: "entity.upsert",
      value: presentedEntity("project", "/other", "finished", true),
    }],
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
  const rows = createProjectProjection({
    entry: () => entry,
    entities: () => model.entities,
  });
  model.observeChanges((changes) => {
    rows.inbox(model.state.inbox, changes);
    if (changes.baseline || changes.entities) {
      rows.entities(changes.baseline ? "all" : changes.entities!);
    }
  });
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
  assertEquals(rows.row(entry.directory, 0)?.unread, false);
  model.receive({
    t: "inbox.patch",
    generation: "g",
    from: 1,
    revision: 3,
    ops: [{
      op: "supervision",
      sessionID: entry.id,
      value: { state: "finishedUnseen", terminal: 3, unseen: true },
    }, {
      op: "entity.upsert",
      value: presentedEntity("project", entry.directory, "finished", true),
    }],
  });
  assertEquals(rows.row(entry.directory, 0)?.unread, true);
  assertEquals(rows.row(entry.directory, 0)?.summary?.unseenCount, null);
  model.receive({
    t: "inbox.patch",
    generation: "g",
    from: 3,
    revision: 6,
    ops: [{ op: "seen", sessionID: entry.id, time: 4 }, {
      op: "supervision",
      sessionID: entry.id,
      value: { state: "none", terminal: 3, unseen: false },
    }, {
      op: "entity.upsert",
      value: presentedEntity("project", entry.directory, "none"),
    }],
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
  assertEquals(rows.row("/idle", 0)?.unseenCount, null);
  assertEquals(rows.row("/idle", 0)?.source, "index");
});
