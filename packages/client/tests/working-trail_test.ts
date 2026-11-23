// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals } from "@std/assert";
import { createTabs, runningWork } from "@otk/client";
import type { InboxSnapshot, IndexEntry } from "@otk/protocol";
import { entitySnapshot } from "./supervision-fixture.ts";

const entry = (
  id: string,
  timeCreated: number,
  parentID?: string,
): IndexEntry => ({
  id,
  title: id,
  parentID,
  directory: "/p",
  projectID: "p",
  timeCreated,
  timeUpdated: timeCreated,
  archived: false,
  status: "idle",
  digest: { state: "digesting", revision: 0, turns: {} },
  attention: {
    permissions: 0,
    questions: 0,
    childPermissions: 0,
    childQuestions: 0,
  },
});

for (const grouped of [true, false]) {
  Deno.test(`family trail retains mandatory helpers while composer shares working subset grouped=${grouped}`, () => {
    const root = entry("root", 1),
      late = entry("late", 30, root.id),
      early = entry("early", 10, root.id),
      nested = entry("nested", 20, early.id),
      finished = entry("finished", 2, root.id),
      unrelated = entry("unrelated", 3);
    const entries = [root, late, nested, early, finished, unrelated];
    for (const entry of [early, nested, late, unrelated]) {
      entry.activity = { work: { fresh: true, keys: [`native:${entry.id}`] } };
    }
    const inbox: InboxSnapshot = {
      tasks: grouped
        ? [{
          id: "task",
          directory: "/p",
          name: "Task",
          order: 0,
          sessions: [root.id],
        }]
        : [],
      projects: [],
      pathTemplates: [],
      seen: {},
      finishes: {},
      supervision: {
        root: { state: "none", terminal: 0 },
        early: { state: "working", terminal: 0 },
        nested: { state: "working", terminal: 0 },
        late: { state: "working", terminal: 0 },
        finished: { state: "finishedUnseen", terminal: 50 },
        unrelated: { state: "working", terminal: 0 },
      },
    };
    const tabs = createTabs(() => Promise.reject(new Error("No promotion")));
    let connected = true;
    const update = () => {
      inbox.entities = entitySnapshot(inbox);
      tabs.update({ directory: "/p", entries, inbox, connected });
    };
    const helpers = () =>
      runningWork({
        tabs,
        inbox,
        sessionID: tabs.state.sessionID!,
        entry: (id) => entries.find((entry) => entry.id === id),
        messages: [],
        connected,
      }).filter((item) => item.kind === "helper").map((item) => item.sessionID);
    update();
    tabs.preview(root.id);
    assertEquals(tabs.crumbs().map((crumb) => crumb.id), [
      "root",
    ]);
    assertEquals(helpers(), ["early", "nested", "late"]);
    tabs.preview(nested.id);
    assertEquals(tabs.crumbs().map((crumb) => crumb.id), [
      "root",
      "early",
      "nested",
    ]);
    for (const id of ["early", "nested", "late"]) {
      inbox.supervision![id] = { state: "finishedUnseen", terminal: 60 };
      entries.find((entry) => entry.id === id)!.activity!.work!.keys = [];
    }
    update();
    assertEquals(tabs.crumbs().map((crumb) => crumb.id), [
      "root",
      "early",
      "nested",
    ]);
    assertEquals(helpers(), []);
    inbox.supervision!.early = { state: "none", terminal: 60 };
    inbox.supervision!.nested = { state: "none", terminal: 60 };
    update();
    assertEquals(tabs.crumbs().map((crumb) => crumb.id), [
      "root",
      "early",
      "nested",
    ]);
    // A native rerun counts under its ancestor, never under an open sibling.
    inbox.supervision!.late = { state: "working", terminal: 60 };
    late.activity!.work!.keys = ["native:rerun"];
    inbox.supervision!.finished = { state: "needsYou", terminal: 50 };
    update();
    assertEquals(tabs.crumbs().map((crumb) => crumb.id), [
      "root",
      "early",
      "nested",
    ]);
    assertEquals(helpers(), []);
    tabs.preview(root.id);
    assertEquals(helpers(), ["late"]);
    tabs.preview(nested.id);
    connected = false;
    update();
    assertEquals(tabs.crumbs().map((crumb) => crumb.id), [
      "root",
      "early",
      "nested",
    ]);
    assertEquals(helpers(), []);
    tabs.stop();
  });
}
