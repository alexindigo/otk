// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals } from "@std/assert";
import { createTabs } from "@otk/client";
import type { InboxSnapshot, IndexMetadata } from "@otk/protocol";

const entry = (id: string): IndexMetadata => ({
  id,
  title: id,
  directory: "/project",
  projectID: "project",
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
const inbox = (): InboxSnapshot => ({
  projects: [],
  tasks: [],
  seen: {},
  finishes: {},
  pathTemplates: [],
});

Deno.test("@load @sessions selected tab title never walks or borrows the unrelated population", () => {
  for (const population of [200, 4000]) {
    let unrelatedTitles = 0,
      unrelatedIdentities = 0,
      selectedTitles = 0,
      catalogReads = 0;
    const selected = entry("selected");
    Object.defineProperty(selected, "title", {
      get() {
        selectedTitles++;
        return "Selected session";
      },
    });
    const entries = Array.from({ length: population }, (_, i) => {
      const id = `unrelated-${i}`, value = entry(id);
      Object.defineProperty(value, "id", {
        get() {
          unrelatedIdentities++;
          return id;
        },
      });
      Object.defineProperty(value, "title", {
        get() {
          unrelatedTitles++;
          return id;
        },
      });
      return value;
    });
    entries.push(selected);
    const tabs = createTabs(() => Promise.reject(new Error("No promotion")));
    try {
      tabs.update({
        directory: "/project",
        get entries() {
          catalogReads++;
          return entries;
        },
        inbox: inbox(),
      });
      assertEquals(tabs.selectedTitle(), undefined);
      tabs.preview(selected.id);
      unrelatedTitles =
        unrelatedIdentities =
        selectedTitles =
        catalogReads =
          0;
      for (let i = 0; i < 10; i++) {
        assertEquals(tabs.selectedTitle(), "Selected session");
      }
      assertEquals({
        unrelatedTitles,
        unrelatedIdentities,
        selectedTitles,
        catalogReads,
      }, {
        unrelatedTitles: 0,
        unrelatedIdentities: 0,
        selectedTitles: 10,
        catalogReads: 0,
      });
    } finally {
      tabs.stop();
    }
  }
});

Deno.test("selected tab title follows task naming, helper selection and membership retirement", () => {
  const tabs = createTabs(() => Promise.reject(new Error("No promotion")));
  const root = entry("root"), child = { ...entry("child"), parentID: "root" };
  const metadata = inbox();
  metadata.tasks = [{
    id: "task",
    directory: "/project",
    name: "Task title",
    sessions: [root.id],
    order: 0,
  }];
  const input = {
    directory: "/project",
    entries: [root, child],
    inbox: metadata,
  };
  try {
    tabs.update(input);
    tabs.preview(child.id);
    assertEquals(tabs.selectedTitle(), "Task title");
    assertEquals(tabs.state.sessionID, child.id);
    metadata.tasks[0].name = "Renamed task";
    tabs.update(input);
    assertEquals(tabs.selectedTitle(), "Renamed task");
    metadata.tasks = [];
    tabs.update(input);
    assertEquals(tabs.selectedTitle(), root.title);
    tabs.select({ kind: "session", id: root.id }, child.id);
    assertEquals(tabs.selectedTitle(), root.title);
    tabs.update({ directory: "/other", entries: [], inbox: inbox() });
    assertEquals(tabs.selectedTitle(), undefined);
  } finally {
    tabs.stop();
  }
});
