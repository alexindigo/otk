// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals } from "@std/assert";
import {
  createIndex,
  createServerResources,
  createState,
  SidecarConnection,
} from "../mod.ts";
import type { ClientSidecars, SidecarState } from "../mod.ts";
import {
  entityKey,
  type InboxSnapshot,
  type IndexEntry,
  taskEntityID,
} from "@otk/protocol";

Deno.test("request activity keeps the phantom visible, leaves projects to received state and never changes native facts", () => {
  const index = createIndex(),
    connection = new SidecarConnection("http://localhost", {
      status() {},
      frame() {},
    });
  const entry: IndexEntry = {
    id: "tstv1-one",
    directory: "/one",
    projectID: "one",
    title: "One",
    status: "idle",
    archived: false,
    timeCreated: 1,
    timeUpdated: 1,
    attention: {
      permissions: 0,
      questions: 0,
      childPermissions: 0,
      childQuestions: 0,
    },
    digest: { state: "digesting", revision: 0, turns: {} },
  };
  index.receive("local", { t: "index.snapshot", rev: 0, entries: [entry] });
  const state = createState<{ list: SidecarState[] }>({
    list: [{
      id: "local",
      baseUrl: "",
      label: "Local",
      status: "connected",
      harness: "connected",
      capabilities: [],
      connectionVersion: 1,
    }],
  });
  const sidecars: ClientSidecars = {
    state: state.state,
    subscribe: state.subscribe,
    connection: () => connection,
    start() {},
    stop() {},
    add: () => Promise.resolve("local"),
    remove() {},
  };
  const resources = createServerResources({ index, sidecars: () => sidecars });
  const inbox: InboxSnapshot = {
    projects: [{
      directory: "/one",
      lastVisit: 1,
      inactive: true,
      added: true,
    }],
    tasks: [],
    seen: {},
    finishes: {},
    pathTemplates: [],
  };
  resources.receive("local", {
    t: "projects.order",
    revision: 1,
    projects: [{ id: "one", directories: ["/one"] }],
  });
  resources.receive("local", {
    t: "programs",
    revision: 1,
    auto: false,
    programs: [],
    members: {},
  });
  resources.receive("local", {
    t: "inbox.snapshot",
    generation: "fixture",
    revision: 0,
    inbox,
  });
  const window = { id: crypto.randomUUID(), expiresAt: Date.now() + 60000 };
  connection.rpc.requests.connect(window, 64);
  const operation = connection.rpc.start("session.rename", {
    sessionID: entry.id,
    title: "New title",
  });
  void operation.result.catch(() => {});
  // Decision 62, plan 3.3: an operation the server has not received does not
  // colour the project (its pending message shows it, P30); received ones
  // arrive as entity states (tests/unit/core/entity-states_test.ts).
  assertEquals(resources.projects(2)[0].status, "none");
  assertEquals(resources.projects(2)[0].inactive, true);
  const project = { sidecarId: "local", directory: "/one" };
  const tabs = resources.tabs(project);
  assertEquals(tabs.tabs(), []); // No server receipt/state yet (D62).
  assertEquals(
    resources.entry("local", entry.id)?.status,
    "idle",
    "Native status remains authoritative",
  );
  const ref = operation.state.ref;
  connection.rpc.receive({
    t: "request.accepted",
    ref,
    seq: 1,
    acceptedAt: 1,
    retentionUntil: 2,
    replayed: false,
  });
  const taskID = taskEntityID("session", entry.id);
  resources.receive("local", {
    t: "inbox.patch",
    generation: "fixture",
    from: 0,
    revision: 1,
    ops: [{
      op: "entity.upsert",
      value: {
        kind: "task",
        id: taskID,
        state: "working",
        previous: "none",
        counts: { working: 1, blocked: 0, finished: 0, unseen: 0 },
      },
    }],
  });
  assertEquals(tabs.tabs().map((tab) => [tab.id, tab.status]), [[
    entry.id,
    "working",
  ]]);
  connection.rpc.requests.disconnect();
  assertEquals(resources.projects(2)[0].status, "none");
  connection.rpc.receive({
    t: "request.result",
    ref,
    seq: 2,
    outcome: {
      ok: false,
      error: {
        code: "session.busy",
        retry: "new-intent",
        diagnosticID: "failure",
      },
    },
  });
  assertEquals(resources.projects(2)[0].status, "none");
  resources.receive("local", {
    t: "inbox.patch",
    generation: "fixture",
    from: 1,
    revision: 2,
    ops: [{ op: "entity.remove", key: entityKey("task", taskID) }],
  });
  tabs.update(resources.tabSnapshot(project));
  assertEquals(tabs.tabs(), []);
  assertEquals(connection.rpc.feedback(entry.id).current()?.kind, "error");
  resources.stop();
});

Deno.test("a project-owned creation before any task or session ID exists leaves the project to received state, and reads stay quiet", () => {
  const index = createIndex(),
    connection = new SidecarConnection("http://localhost", {
      status() {},
      frame() {},
    });
  const state = createState<{ list: SidecarState[] }>({
    list: [{
      id: "local",
      baseUrl: "",
      label: "Local",
      status: "connected",
      harness: "connected",
      capabilities: [],
      connectionVersion: 1,
    }],
  });
  const sidecars: ClientSidecars = {
    state: state.state,
    subscribe: state.subscribe,
    connection: () => connection,
    start() {},
    stop() {},
    add: () => Promise.resolve("local"),
    remove() {},
  };
  const resources = createServerResources({ index, sidecars: () => sidecars });
  resources.receive("local", {
    t: "projects.order",
    revision: 1,
    projects: [{ id: "empty", directories: ["/empty"] }],
  });
  resources.receive("local", {
    t: "programs",
    revision: 1,
    auto: false,
    programs: [],
    members: {},
  });
  resources.receive("local", {
    t: "inbox.snapshot",
    generation: "fixture",
    revision: 0,
    inbox: {
      projects: [{
        directory: "/empty",
        lastVisit: 1,
        inactive: true,
        added: true,
      }],
      tasks: [],
      seen: {},
      finishes: {},
      pathTemplates: [],
    },
  });
  connection.rpc.requests.connect({
    id: crypto.randomUUID(),
    expiresAt: Date.now() + 60000,
  }, 64);
  const read = connection.rpc.start("tasks.list", { directory: "/empty" });
  void read.result.catch(() => {});
  assertEquals(resources.projects(2)[0].status, "none");
  const create = connection.rpc.start("tasks.create", {
    directory: "/empty",
    name: "perf",
  });
  void create.result.catch(() => {});
  // Decision 62, plan 3.3: only received operations colour the project, through
  // the server's checkout operation input (core entity-states tests).
  assertEquals(resources.projects(2)[0].status, "none");
  assertEquals(resources.projects(2)[0].inactive, true);
  connection.rpc.receive({
    t: "request.accepted",
    ref: create.state.ref,
    seq: 1,
    acceptedAt: 1,
    retentionUntil: 2,
    replayed: false,
  });
  create.release();
  assertEquals(resources.projects(2)[0].status, "none");
  resources.stop();
});
