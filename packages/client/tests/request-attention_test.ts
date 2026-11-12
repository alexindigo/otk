// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals } from "@std/assert";
import { createTabs, inboxProjects, Rpc } from "../mod.ts";
import { requestAttention } from "../request-attention.ts";
import {
  createRequestMetadata,
  type InboxSnapshot,
  type IndexMetadata,
  type RpcMethod,
  type RpcParams,
  type TaskRecord,
} from "@otk/protocol";

const entry = (id: string): IndexMetadata => ({
  id,
  directory: "/p",
  projectID: "p",
  title: id,
  timeCreated: 1,
  timeUpdated: 1,
  archived: false,
  status: "idle",
  attention: {
    permissions: 0,
    questions: 0,
    childPermissions: 0,
    childQuestions: 0,
  },
});
const inbox: InboxSnapshot = {
  projects: [{
    directory: "/p",
    order: 0,
    added: true,
    inactive: true,
    lastVisit: 0,
  }],
  tasks: [],
  seen: {},
  finishes: {},
  pathTemplates: [],
};
function setup() {
  const rpc = new Rpc(() => {});
  rpc.requests.connect({
    id: crypto.randomUUID(),
    expiresAt: Date.now() + 60000,
  }, 64);
  const start = <M extends RpcMethod>(
    method: M,
    params: RpcParams<M>,
    owner: string,
    failed = true,
  ) => {
    const operation = rpc.start(method, params, { owner });
    void operation.result.catch(() => {});
    if (failed) {
      rpc.receive({
        t: "request.result",
        ref: operation.state.ref,
        seq: 1,
        outcome: {
          ok: false,
          error: {
            code: "session",
            retry: "new-intent",
            diagnosticID: "unavailable",
          },
        },
      });
    }
    return operation;
  };
  const project = (entries: IndexMetadata[], tasks: TaskRecord[] = []) => {
    const attention = requestAttention(
      rpc.requests.operations(),
      createRequestMetadata(),
      entries,
      tasks,
    );
    const decorated = attention.entries(entries);
    const tabs = createTabs(() => Promise.reject(new Error("No promotion")));
    const snapshot = { ...inbox, tasks };
    tabs.update({
      directory: "/p",
      entries: decorated,
      inbox: snapshot,
      taskActivity: attention.tasks,
    });
    return {
      tabs: tabs.tabs(),
      projects: attention.projects(inboxProjects(decorated, snapshot, 1)),
      entries: decorated,
    };
  };
  return { rpc, start, project };
}

Deno.test("authoritative tombstones retire pending and failed operation attention, in either arrival order", () => {
  for (const failed of [false, true]) {
    const { rpc, start, project } = setup();
    const session = entry("tstv1-deleted");
    const operation = start(
      "session.rename",
      { sessionID: session.id, title: "Renamed" },
      session.id,
      failed,
    );
    assertEquals(
      project([session]).tabs[0]?.status,
      failed ? "blocked" : "working",
    );
    session.deleted = { at: 2, how: "otk" };
    assertEquals(project([session]).tabs, []);
    assertEquals(project([session]).projects[0].status, "none");
    assertEquals(project([session]).projects[0].inactive, true);
    if (!failed) {
      rpc.receive({
        t: "request.result",
        ref: operation.state.ref,
        seq: 1,
        outcome: {
          ok: false,
          error: { code: "session", retry: "new-intent", diagnosticID: "late" },
        },
      });
    }
    assertEquals(project([session]).tabs, []);
    rpc.requests.stop();
  }
});

Deno.test("failed automatic bookkeeping never creates mandatory attention; live user failures still do", () => {
  for (
    const method of [
      "sessions.seen",
      "projects.visit",
      "frecency.bump",
      "layout.location",
    ] as const
  ) {
    const { rpc, start, project } = setup();
    const session = entry("tstv1-seen");
    const params = {
      "sessions.seen": { sessionID: session.id, terminal: 0 },
      "projects.visit": { directory: "/p" },
      "frecency.bump": { sessionID: session.id, path: "file.ts" },
      "layout.location": {
        sidecarId: "local",
        directory: "/p",
        sessionID: session.id,
      },
    };
    start(method, params[method], session.id);
    assertEquals(project([session]).tabs, [], method);
    session.deleted = { at: 2, how: "otk" };
    assertEquals(project([session]).tabs, [], method);
    assertEquals(project([session]).projects[0].status, "none", method);
    const live = entry("tstv1-live");
    start("session.rename", { sessionID: live.id, title: "Renamed" }, live.id);
    assertEquals(
      project([session, live]).tabs.map((tab) => [tab.id, tab.status]),
      [[live.id, "blocked"]],
    );
    assertEquals(project([session, live]).projects[0].status, "blocked");
    rpc.requests.stop();
  }
});

Deno.test("task and child operation attention cannot reanimate a deleted session", () => {
  const { rpc, start, project } = setup();
  const deleted = {
    ...entry("tstv1-parent"),
    deleted: { at: 2, how: "provider" as const },
  };
  const child = { ...entry("tstv1-child"), parentID: deleted.id };
  start("session.rename", { sessionID: child.id, title: "Renamed" }, child.id);
  assertEquals(
    project([deleted, child]).entries.map((row) => row.operationStatus),
    [undefined, "blocked"],
  );
  start("tasks.rename", { id: "task", name: "Renamed" }, "task");
  const result = project([deleted, child], [{
    id: "task",
    name: "Task",
    directory: "/p",
    order: 0,
    sessions: [deleted.id, child.id],
  }]);
  assertEquals(result.entries.map((row) => row.operationStatus), [
    undefined,
    "blocked",
  ]);
  assertEquals(result.tabs.map((tab) => [tab.id, tab.status]), [[
    "task",
    "blocked",
  ]]);
  rpc.requests.stop();
});
