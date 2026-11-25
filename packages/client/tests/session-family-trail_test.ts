// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals } from "@std/assert";
import { createTabs } from "./supervision-fixture.ts";
import type { InboxSnapshot, IndexMetadata } from "@otk/protocol";
import { entitySnapshot } from "./supervision-fixture.ts";

const entry = (id: string, parentID?: string): IndexMetadata => ({
  id,
  parentID,
  title: id,
  directory: "/p",
  projectID: "p",
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
for (const grouped of [true, false]) {
  Deno.test(`D66/D3 trail filters background helpers but always ends at quiet selection grouped=${grouped}`, () => {
    const entries = [
      entry("root"),
      entry("open", "root"),
      entry("blocked", "root"),
      entry("unseen", "root"),
      entry("working", "root"),
      entry("quiet", "root"),
      entry("foreign"),
    ];
    const inbox: InboxSnapshot = {
      tasks: grouped
        ? [{
          id: "task",
          name: "Task",
          directory: "/p",
          order: 0,
          sessions: ["root"],
        }]
        : [],
      projects: [],
      pathTemplates: [],
      seen: {},
      finishes: {},
      supervision: {
        blocked: { state: "needsYou", terminal: 0 },
        unseen: { state: "finishedUnseen", terminal: 2 },
        working: { state: "working", terminal: 0 },
        foreign: { state: "working", terminal: 0 },
      },
    };
    const tabs = createTabs(() => Promise.reject(new Error("No promotion")));
    const update = () => {
      inbox.entities = entitySnapshot(inbox);
      tabs.update({ directory: "/p", entries, inbox });
    };
    update();
    tabs.preview("open");
    assertEquals(tabs.crumbs().map((c) => c.id), [
      "root",
      "open",
    ]);
    assertEquals(tabs.path().map((c) => c.id), ["root", "open"]);
    inbox.supervision!.unseen = { state: "none", terminal: 2 };
    inbox.supervision!.blocked = { state: "none", terminal: 0 };
    update();
    assertEquals(tabs.crumbs().map((c) => c.id), ["root", "open"]);
    assertEquals(tabs.trail().path.map((c) => c.id), ["root", "open"]);
    tabs.stop();
  });
}

Deno.test("path excludes nonexistent parents and repeated cycle identities", () => {
  const tabs = createTabs(() => Promise.reject(new Error("No promotion")));
  const inbox: InboxSnapshot = {
    tasks: [],
    projects: [],
    pathTemplates: [],
    seen: {},
    finishes: {},
  };
  tabs.update({ directory: "/p", entries: [entry("open", "missing")], inbox });
  tabs.preview("open");
  assertEquals(tabs.path().map((c) => c.id), ["open"]);
  tabs.update({
    directory: "/p",
    entries: [entry("open", "parent"), entry("parent", "open")],
    inbox,
  });
  assertEquals(new Set(tabs.path().map((c) => c.id)).size, tabs.path().length);
});
