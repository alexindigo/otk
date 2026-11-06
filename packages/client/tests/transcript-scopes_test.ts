// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals } from "@std/assert";
import {
  type BodyTarget,
  type ClientSession,
  createTranscriptScopes,
  type ScopeRef,
  type TranscriptDemand,
} from "../mod.ts";
import { shellEntry, shellFixture, shellTask } from "./shell-fixture.ts";

Deno.test("project acquisition without selection cannot replace a retained warm body scope with empty membership", () => {
  const f = shellFixture(), demands: TranscriptDemand[] = [];
  const session = {
    demand: (value: TranscriptDemand) => demands.push(value),
    transcripts: {},
  } as unknown as ClientSession;
  const owner = createTranscriptScopes({ resources: f.resources, session });
  try {
    f.resources.receive("local", {
      t: "index.snapshot",
      rev: 0,
      entries: [shellEntry("a")],
    });
    f.resources.receive("local", {
      t: "inbox.snapshot",
      generation: "one",
      revision: 0,
      inbox: {
        projects: [],
        tasks: [],
        seen: {},
        finishes: {},
        pathTemplates: [],
      },
    });
    owner.update({
      project: { sidecarId: "local", directory: "/p" },
      selected: { sidecarId: "local", sessionID: "a" },
      screen: true,
    });
    assertEquals(demands.at(-1)?.scope?.directory, "/p");
    owner.update({
      project: { sidecarId: "local", directory: "/q" },
      screen: true,
    });
    assertEquals(demands.at(-1)?.scope, undefined);
    assertEquals(demands.at(-1)?.sessions, []);
  } finally {
    owner.stop();
    f.resources.stop();
  }
});

Deno.test("pending inbox readiness cannot conflate different project scope keys", () => {
  const f = shellFixture(), scopes: string[] = [];
  f.resources.scope = (project) => {
    if (project) scopes.push(project.directory);
  };
  const session = { demand() {}, transcripts: {} } as unknown as ClientSession;
  const owner = createTranscriptScopes({ resources: f.resources, session });
  try {
    owner.update({
      project: { sidecarId: "local", directory: "/p" },
      screen: true,
    });
    owner.update({
      project: { sidecarId: "local", directory: "/q" },
      screen: true,
    });
    assertEquals(scopes, ["/p", "/q"]);
  } finally {
    owner.stop();
    f.resources.stop();
  }
});

Deno.test("ordinary digest metadata does not rebuild active body demand or scan the full catalog", () => {
  const f = shellFixture(), demands: TranscriptDemand[] = [];
  const session = {
    demand: (value: TranscriptDemand) => demands.push(value),
    transcripts: { preload() {} },
  } as unknown as ClientSession;
  const owner = createTranscriptScopes({ resources: f.resources, session });
  try {
    f.resources.receive("local", {
      t: "index.snapshot",
      rev: 0,
      entries: [shellEntry("a"), shellEntry("other", "/q")],
    });
    f.resources.receive("local", {
      t: "inbox.snapshot",
      generation: "fixture",
      revision: 0,
      inbox: {
        projects: [],
        tasks: [],
        seen: {},
        finishes: {},
        pathTemplates: [],
      },
    });
    owner.update({
      project: { sidecarId: "local", directory: "/p" },
      selected: { sidecarId: "local", sessionID: "a" },
      screen: true,
    });
    const before = demands.length;
    let catalogs = 0;
    const entries = f.resources.indexEntries.bind(f.resources);
    f.resources.indexEntries = (id) => {
      catalogs++;
      return entries(id);
    };
    f.resources.receive("local", {
      t: "index.patch",
      rev: 1,
      ops: [{
        op: "digest",
        id: "other",
        revision: 1,
        summary: { state: "ready", revision: 1 },
        turns: { upsert: {}, remove: [] },
        deleted: null,
      }],
    });
    assertEquals(
      demands.length,
      before,
      "Unchanged membership cannot re-admit the scope",
    );
    assertEquals(
      catalogs,
      0,
      "The metadata owner already knows which identity changed",
    );
  } finally {
    owner.stop();
    f.resources.stop();
  }
});

Deno.test("body scope uses nearest task ancestry but admits only the selected session; crumbs stay metadata-only", () => {
  const f = shellFixture();
  const demands: TranscriptDemand[] = [];
  const preloads: {
    target: BodyTarget;
    scope: ScopeRef;
    sessions: readonly BodyTarget[];
  }[] = [];
  const session = {
    demand: (value: TranscriptDemand) => demands.push(value),
    transcripts: {
      preload: (
        target: BodyTarget,
        scope: ScopeRef,
        sessions: readonly BodyTarget[],
      ) => preloads.push({ target, scope, sessions }),
    },
  } as unknown as ClientSession;
  const owner = createTranscriptScopes({ resources: f.resources, session });
  try {
    f.resources.receive("local", {
      t: "index.snapshot",
      rev: 0,
      entries: [
        shellEntry("root"),
        shellEntry("other"),
        shellEntry("helper", "/p", "root"),
        shellEntry("sibling"),
        shellEntry("foreign", "/q"),
      ],
    });
    f.resources.receive("local", {
      t: "inbox.snapshot",
      generation: "fixture",
      revision: 0,
      inbox: {
        projects: [],
        tasks: [shellTask("task", ["sibling", "root"])],
        seen: {},
        finishes: {},
        pathTemplates: [],
      },
    });
    owner.update({
      project: { sidecarId: "local", directory: "/p" },
      selected: { sidecarId: "local", sessionID: "helper" },
      screen: true,
    });
    assertEquals(demands.at(-1)?.scope, {
      sidecarId: "local",
      directory: "/p",
      taskID: "task",
    });
    assertEquals(demands.at(-1)?.sessions.map((t) => t.sessionID), [
      "helper",
    ]);
    owner.update({
      project: { sidecarId: "local", directory: "/p" },
      selected: { sidecarId: "local", sessionID: "helper" },
      screen: false,
    });
    assertEquals(demands.at(-1)?.selected, undefined);
    assertEquals(demands.at(-1)?.sessions.length, 1);
    assertEquals(preloads, []);
  } finally {
    owner.stop();
    f.resources.stop();
  }
});

Deno.test("initial and repeated attention/digest/finish metadata never preloads unselected task bodies", () => {
  const f = shellFixture();
  const preloads: unknown[][] = [];
  const session = {
    demand() {},
    transcripts: { preload: (...value: unknown[]) => preloads.push(value) },
  } as unknown as ClientSession;
  const owner = createTranscriptScopes({ resources: f.resources, session });
  const busy = { ...shellEntry("a"), status: "busy" as const };
  const inbox = {
    projects: [],
    tasks: [shellTask("task", ["a", "b"])],
    seen: {},
    finishes: {},
    pathTemplates: [],
  };
  try {
    f.resources.receive("local", {
      t: "index.snapshot",
      rev: 0,
      entries: [busy, shellEntry("b")],
    });
    assertEquals(preloads.length, 0);
    f.resources.receive("local", {
      t: "inbox.snapshot",
      generation: "fixture",
      revision: 0,
      inbox,
    });
    assertEquals(preloads, []);
    f.resources.receive("local", {
      t: "index.snapshot",
      rev: 1,
      entries: [{
        ...busy,
        digest: { state: "digesting", revision: 2, turns: {} },
      }, shellEntry("b")],
    });
    f.resources.receive("local", {
      t: "inbox.snapshot",
      generation: "fixture",
      revision: 0,
      inbox,
    });
    assertEquals(preloads, []);
    f.resources.receive("local", {
      t: "index.snapshot",
      rev: 2,
      entries: [shellEntry("a"), shellEntry("b")],
    });
    f.resources.receive("local", {
      t: "inbox.snapshot",
      generation: "fixture",
      revision: 0,
      inbox: { ...inbox, finishes: { a: 9 } },
    });
    assertEquals(preloads, []);
    f.resources.receive("local", {
      t: "inbox.snapshot",
      generation: "fixture",
      revision: 0,
      inbox: { ...inbox, finishes: { a: 9 } },
    });
    assertEquals(preloads, []);
    f.resources.receive("local", {
      t: "inbox.snapshot",
      generation: "fixture",
      revision: 0,
      inbox: { ...inbox, finishes: { a: 10 } },
    });
    assertEquals(preloads, []);
    assertEquals(f.calls, []);
  } finally {
    owner.stop();
    f.resources.stop();
  }
});

Deno.test("distinct cross-project attention edges cannot admit transcript preload demand", () => {
  const f = shellFixture(), preloads: unknown[][] = [];
  const session = {
    demand() {},
    transcripts: { preload: (...value: unknown[]) => preloads.push(value) },
  } as unknown as ClientSession;
  const owner = createTranscriptScopes({ resources: f.resources, session });
  let revision = 0;
  const snapshot = (permissions: number, questions = 0) => {
    const row = shellEntry("a");
    row.attention.permissions = permissions;
    row.attention.questions = questions;
    f.resources.receive("local", {
      t: "index.snapshot",
      rev: ++revision,
      entries: [row],
    });
  };
  try {
    f.resources.receive("local", {
      t: "inbox.snapshot",
      generation: "fixture",
      revision: 0,
      inbox: {
        projects: [],
        tasks: [],
        seen: {},
        finishes: {},
        pathTemplates: [],
      },
    });
    snapshot(1);
    assertEquals(preloads, []);
    snapshot(2);
    assertEquals(preloads, []);
    snapshot(1);
    assertEquals(preloads, []);
    snapshot(1, 1);
    assertEquals(preloads, []);
    snapshot(1, 1);
    assertEquals(preloads, []);
  } finally {
    owner.stop();
    f.resources.stop();
  }
});
