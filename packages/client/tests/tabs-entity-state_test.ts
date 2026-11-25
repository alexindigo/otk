// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals } from "@std/assert";
import { createEntityStateStore, createTabs } from "@otk/client";
import {
  entityKey,
  type EntityState,
  type InboxSnapshot,
  type IndexMetadata,
  taskEntityID,
} from "@otk/protocol";

Deno.test("tab and ancestry lamps borrow separate task and own-session entities, never metadata or operation overlays", () => {
  const row: IndexMetadata = {
    id: "root",
    directory: "/p",
    projectID: "p",
    title: "Root",
    timeCreated: 1,
    timeUpdated: 1,
    archived: false,
    status: "busy",
    attention: {
      permissions: 9,
      questions: 9,
      childPermissions: 9,
      childQuestions: 9,
    },
  };
  const taskID = taskEntityID("task", false, "/p");
  const value = (
    kind: "session" | "task",
    id: string,
    state: EntityState["state"],
  ): EntityState => ({
    kind,
    id,
    state,
    previous: state,
    counts: {
      working: Number(state === "working"),
      blocked: Number(state === "blocked"),
      finished: Number(state === "finished"),
      unseen: 0,
    },
  });
  const inbox: InboxSnapshot = {
    projects: [],
    tasks: [{
      id: "task",
      directory: "/p",
      name: "Task",
      sessions: [row.id],
      order: 0,
    }],
    seen: {},
    finishes: {},
    pathTemplates: [],
    entities: {
      [entityKey("task", taskID)]: value("task", taskID, "working"),
      [entityKey("session", row.id)]: value("session", row.id, "none"),
    },
  };
  const entities = createEntityStateStore({ read: () => inbox.entities });
  const tabs = createTabs(() => Promise.reject(Error("No promotion")));
  try {
    entities.observe("all", "live");
    tabs.update({
      directory: "/p",
      entries: [row],
      inbox,
      entities,
      taskActivity: { task: "blocked" },
    });
    tabs.select({ kind: "task", id: "task" }, row.id);
    assertEquals(tabs.tabs()[0].status, "working");
    assertEquals(tabs.path()[0].status, "none");
    inbox.entities![entityKey("task", taskID)] = value(
      "task",
      taskID,
      "blocked",
    );
    entities.observe([entityKey("task", taskID)], "live");
    assertEquals(tabs.tabs()[0].status, "blocked");
    entities.stale(true);
    assertEquals(tabs.tabs()[0].status, "none");
    assertEquals(tabs.path()[0].status, "none");
  } finally {
    tabs.stop();
    entities.stop();
  }
});
