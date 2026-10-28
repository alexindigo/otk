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

Deno.test("body scope uses nearest task ancestry, preserves member order, and visibility releases screen only", () => {
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
      t: "inbox",
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
      "sibling",
      "root",
      "helper",
    ]);
    owner.update({
      project: { sidecarId: "local", directory: "/p" },
      selected: { sidecarId: "local", sessionID: "helper" },
      screen: false,
    });
    assertEquals(demands.at(-1)?.selected, undefined);
    assertEquals(demands.at(-1)?.sessions.length, 3);
    assertEquals(preloads, []);
  } finally {
    owner.stop();
    f.resources.stop();
  }
});

Deno.test("initial attentive metadata waits for task ownership; repeated busy/digest/seen frames cannot renew a preload edge", () => {
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
    f.resources.receive("local", { t: "inbox", inbox });
    assertEquals(preloads.length, 1);
    assertEquals(preloads[0][1], {
      sidecarId: "local",
      directory: "/p",
      taskID: "task",
    });
    f.resources.receive("local", {
      t: "index.snapshot",
      rev: 1,
      entries: [{
        ...busy,
        digest: { state: "digesting", revision: 2, turns: {} },
      }, shellEntry("b")],
    });
    f.resources.receive("local", { t: "inbox", inbox });
    assertEquals(preloads.length, 1);
    f.resources.receive("local", {
      t: "index.snapshot",
      rev: 2,
      entries: [shellEntry("a"), shellEntry("b")],
    });
    f.resources.receive("local", {
      t: "inbox",
      inbox: { ...inbox, finishes: { a: 9 } },
    });
    assertEquals(preloads.length, 2);
    f.resources.receive("local", {
      t: "inbox",
      inbox: { ...inbox, finishes: { a: 9 } },
    });
    assertEquals(preloads.length, 2);
    f.resources.receive("local", {
      t: "inbox",
      inbox: { ...inbox, finishes: { a: 10 } },
    });
    assertEquals(preloads.length, 3);
    assertEquals(f.calls, []);
  } finally {
    owner.stop();
    f.resources.stop();
  }
});

Deno.test("distinct new attention renews a scope while another request remains blocked, but resolution does not", () => {
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
      t: "inbox",
      inbox: {
        projects: [],
        tasks: [],
        seen: {},
        finishes: {},
        pathTemplates: [],
      },
    });
    snapshot(1);
    assertEquals(preloads.length, 1);
    snapshot(2);
    assertEquals(preloads.length, 2);
    snapshot(1);
    assertEquals(preloads.length, 2);
    snapshot(1, 1);
    assertEquals(preloads.length, 3);
    snapshot(1, 1);
    assertEquals(preloads.length, 3);
  } finally {
    owner.stop();
    f.resources.stop();
  }
});
