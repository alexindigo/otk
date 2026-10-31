// SPDX-License-Identifier: LGPL-3.0-only
import {
  type ClientSidecars,
  createIndex,
  createServerResources,
  createState,
  type ServerResources,
  SidecarConnection,
  type TabInput,
} from "@otk/client";
import type { InboxSnapshot, IndexEntry } from "@otk/protocol";

/** Independent public-entry consumer; no app, Solid, persistence or private paths. */
export function remainingTabs() {
  const index = createIndex();
  const state = createState({
    list: [{
      id: "external",
      baseUrl: "",
      label: "External",
      status: "connected" as const,
      harness: "connected" as const,
      capabilities: [],
      connectionVersion: 1,
    }],
  });
  const connection = new SidecarConnection("http://127.0.0.1:1", {
    status() {},
    frame() {},
  });
  connection.send = () => {};
  const sidecars: ClientSidecars = {
    state: state.state,
    subscribe: state.subscribe,
    connection: () => connection,
    start() {},
    stop() {},
    add: () => Promise.resolve("external"),
    remove() {},
  };
  const resources: ServerResources = createServerResources({
    index,
    sidecars: () => sidecars,
  });
  const entry = (n: number, title: string): IndexEntry => ({
    id: `tstv1-${n}`,
    directory: `/p-${n % 100}`,
    projectID: "external",
    title,
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
    digest: { state: "ready", revision: 1, messageCount: 0, turns: {} },
  });
  const inbox = (): InboxSnapshot => ({
    projects: [],
    pathTemplates: [],
    tasks: Array.from(
      { length: 100 },
      (_, n) => ({
        id: `task-${n}`,
        directory: `/p-${n}`,
        name: `Task ${n}`,
        order: n,
        sessions: [`tstv1-${n}`],
      }),
    ),
    seen: Object.fromEntries(
      Array.from({ length: 4615 }, (_, n) => [`tstv1-${n}`, 1]),
    ),
    finishes: {},
  });
  resources.receive("external", {
    t: "index.snapshot",
    rev: 0,
    entries: Array.from({ length: 4615 }, (_, n) => entry(n, `Before ${n}`)),
  });
  resources.receive("external", {
    t: "inbox.snapshot",
    generation: "g",
    revision: 0,
    inbox: inbox(),
  });
  const prior = new WeakRef(resources.inbox("external").state.inbox.seen);
  const snapshots: TabInput[] = [];
  for (let cycle = 0; cycle < 10; cycle++) {
    for (let n = 0; n < 100; n++) {
      const project = { sidecarId: "external", directory: `/p-${n}` };
      const snapshot = resources.tabSnapshot(project);
      if (cycle === 0) snapshots.push(snapshot);
      resources.syncTabs(project, snapshot, {
        sidecarId: "external",
        sessionID: `tstv1-${n}`,
      });
      resources.tabs(project).tabs();
    }
  }
  resources.receive("external", {
    t: "index.snapshot",
    rev: 1,
    entries: Array.from({ length: 4615 }, (_, n) => entry(n, `After ${n}`)),
  });
  resources.receive("external", {
    t: "inbox.snapshot",
    generation: "g",
    revision: 1,
    inbox: inbox(),
  });
  const facts = snapshots.map((snapshot, n) => ({
    currentTitle: snapshot.entries.find((value) => value.id === `tstv1-${n}`)
      ?.title,
    currentInbox: snapshot.inbox === resources.inbox("external").state.inbox,
    sourceFree: ["entries", "inbox", "taskActivity"].every((key) =>
      !!Object.getOwnPropertyDescriptor(snapshot, key)?.get
    ),
    entries: snapshot.entries.length,
    selected:
      resources.tabs({ sidecarId: "external", directory: `/p-${n}` }).state
        .sessionID,
  }));
  return {
    facts,
    retainedOldSeen: () => !!prior.deref(),
    stop: () => resources.stop(),
  };
}
