// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals } from "@std/assert";
import {
  createIndex,
  createServerResources,
  createState,
  SidecarConnection,
} from "../mod.ts";
import type { ClientSidecars, SidecarState } from "../mod.ts";
import type { InboxSnapshot, IndexEntry } from "@otk/protocol";

Deno.test("request activity keeps original project and phantom visible without changing native facts", () => {
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
      order: 0,
      lastVisit: 1,
      inactive: true,
      added: true,
    }],
    tasks: [],
    seen: {},
    finishes: {},
    pathTemplates: [],
  };
  resources.receive("local", { t: "inbox", inbox });
  const window = { id: crypto.randomUUID(), expiresAt: Date.now() + 60000 };
  connection.rpc.requests.connect(window, 64);
  const operation = connection.rpc.start("session.rename", {
    sessionID: entry.id,
    title: "New title",
  });
  void operation.result.catch(() => {});
  assertEquals(resources.projects(2)[0].status, "working");
  assertEquals(resources.projects(2)[0].inactive, false);
  const project = { sidecarId: "local", directory: "/one" };
  const tabs = resources.tabs(project);
  assertEquals(tabs.tabs().map((tab) => [tab.id, tab.status]), [[
    entry.id,
    "working",
  ]]);
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
  connection.rpc.requests.disconnect();
  assertEquals(resources.projects(2)[0].status, "working");
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
  assertEquals(resources.projects(2)[0].status, "blocked");
  tabs.update(resources.tabSnapshot(project));
  assertEquals(tabs.tabs()[0].status, "blocked");
  resources.stop();
});

Deno.test("a project-owned creation has activity before a task or session ID exists, while reads stay quiet", () => {
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
    t: "inbox",
    inbox: {
      projects: [{
        directory: "/empty",
        order: 0,
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
  assertEquals(resources.projects(2)[0].status, "idle");
  const create = connection.rpc.start("tasks.create", {
    directory: "/empty",
    name: "perf",
  });
  void create.result.catch(() => {});
  assertEquals(resources.projects(2)[0].status, "working");
  assertEquals(resources.projects(2)[0].inactive, false);
  connection.rpc.receive({
    t: "request.accepted",
    ref: create.state.ref,
    seq: 1,
    acceptedAt: 1,
    retentionUntil: 2,
    replayed: false,
  });
  create.release();
  assertEquals(
    resources.projects(2)[0].status,
    "working",
    "Presentation release cannot hide accepted work",
  );
  resources.stop();
});
