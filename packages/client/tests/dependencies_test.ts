// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals, assertNotStrictEquals } from "@std/assert";
import {
  entityKey,
  type EntityState,
  type InboxSnapshot,
  type IndexMetadata,
  taskEntityID,
} from "@otk/protocol";
import {
  createEntityStateStore,
  createTabs,
  entityState,
  inboxProjects,
} from "../mod.ts";
import { createProjectProjection } from "../project-projection.ts";

const entry = (id = "tstv1-owner"): IndexMetadata => ({
  id,
  directory: "/p",
  projectID: "repo",
  title: id,
  archived: false,
  status: "idle",
  timeCreated: 1,
  timeUpdated: 2,
  attention: {
    permissions: 0,
    questions: 0,
    childPermissions: 0,
    childQuestions: 0,
  },
});
function entity(
  kind: EntityState["kind"],
  id: string,
  dependencies: number,
): EntityState {
  const state = kind !== "session" && dependencies ? "dependencies" : "none";
  return {
    kind,
    id,
    state,
    previous: "none",
    dependencies,
    counts: { blocked: 0, working: 0, finished: 0, unseen: 0 },
  };
}
function snapshot(): InboxSnapshot {
  return {
    projects: [],
    tasks: [],
    seen: {},
    finishes: {},
    pathTemplates: [],
  };
}
Deno.test("task ownership counts only its own sessions; dependency-only phantoms retire at zero", () => {
  const inbox = snapshot(), entries = [entry(), entry("tstv1-other")];
  inbox.tasks = [{
    id: "task",
    directory: "/p",
    name: "Task",
    order: 0,
    sessions: [entries[0].id],
  }];
  const tabs = createTabs(() => Promise.resolve(inbox.tasks[0]));
  const session = (id: string) => entityKey("session", id);
  const tab = (id: string, kind: "task" | "session") =>
    entityKey("task", taskEntityID(kind, id));
  inbox.entities = {
    [session(entries[0].id)]: entity("session", entries[0].id, 2),
    [session(entries[1].id)]: entity("session", entries[1].id, 1),
    [tab("task", "task")]: entity("task", taskEntityID("task", "task"), 2),
    [tab(entries[1].id, "session")]: entity(
      "task",
      taskEntityID("session", entries[1].id),
      1,
    ),
  };
  const store = createEntityStateStore({ read: () => inbox.entities });
  assertEquals(entityState(store, session(entries[0].id)), "none");
  assertEquals(store.get(session(entries[0].id))?.dependencies, 2);
  assertEquals(inbox.finishes, {});
  store.stop();
  tabs.update({ directory: "/p", entries, inbox });
  assertEquals(
    tabs.tabs().map((tab) => [tab.id, tab.status, tab.dependencies]),
    [
      ["tstv1-other", "dependencies", 1],
      ["task", "dependencies", 2],
    ].sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
  );
  const {
    [session(entries[1].id)]: _session,
    [tab(entries[1].id, "session")]: _tab,
    ...remaining
  } = inbox.entities;
  inbox.entities = remaining;
  tabs.update({ directory: "/p", entries, inbox });
  assertEquals(tabs.tabs().map((tab) => tab.id), ["task"]);
  tabs.stop();
});
Deno.test("count-only entity changes invalidate the keyed project row without a metadata update", () => {
  const inbox = snapshot();
  const a = { ...entry(), sidecarId: "local" };
  const key = entityKey("project", "/p");
  let values = { [key]: entity("project", "/p", 2) };
  const entities = createEntityStateStore({ read: () => values });
  entities.observe([key], "historical");
  const projection = createProjectProjection({
    entry: (id) => id === a.id ? a : undefined,
    inbox: () => inbox,
    entities: () => entities,
  });
  projection.update([a.id]);
  projection.inbox(inbox);
  const before = projection.row("/p", 0);
  assertEquals(projection.row("/p", 0)?.dependencies, 2);
  values = { [key]: entity("project", "/p", 3) };
  entities.observe([key], "live");
  projection.entities([key]);
  assertNotStrictEquals(projection.row("/p", 0), before);
  assertEquals(projection.row("/p", 0)?.dependencies, 3);
  assertEquals(projection.row("/p", 0)?.status, "dependencies");
  assertEquals(entityState(entities, entityKey("session", a.id)), "none");
  entities.stop();
});
Deno.test("orphan-only project summaries lift Inactive without fabricating population, then return to policy", () => {
  const inbox = snapshot();
  inbox.projects = [{
    directory: "/orphan",
    order: 0,
    added: true,
    inactive: true,
    lastVisit: 1,
  }];
  inbox.summaries = {
    "/orphan": {
      directory: "/orphan",
      hasSessions: false,
      sessionCount: 0,
      unseenCount: 0,
      lastActivity: null,
      authority: "stale",
      status: "dependencies",
      dependencies: 1,
    },
  };
  const key = entityKey("project", "/orphan");
  inbox.entities = { [key]: entity("project", "/orphan", 1) };
  const row = inboxProjects([], inbox, 10)[0];
  assertEquals([row.status, row.group, row.inactive, row.dependencies], [
    "dependencies",
    "active",
    false,
    1,
  ]);
  const untracked = { ...inbox, projects: [] };
  const store = createEntityStateStore({ read: () => inbox.entities });
  const projection = createProjectProjection({
    entry: () => undefined,
    entities: () => store,
  });
  projection.inbox(untracked);
  assertEquals(projection.directories(), ["/orphan"]);
  assertEquals(projection.row("/orphan", 10)?.dependencies, 1);
  inbox.summaries["/orphan"] = {
    ...inbox.summaries["/orphan"],
    status: "none",
    dependencies: 0,
  };
  inbox.entities[key] = entity("project", "/orphan", 0);
  const stopped = inboxProjects([], inbox, 10)[0];
  assertEquals([stopped.status, stopped.group, stopped.inactive], [
    "none",
    "inactive",
    true,
  ]);
  projection.inbox({ ...inbox, projects: [] });
  assertEquals(projection.directories(), []);
  store.stop();
});
