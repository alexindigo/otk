// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals } from "@std/assert";
import { createTabs } from "../tabs.ts";
import { runningWork, runningWorkLabel } from "../live-work.ts";
import { shellEntry, shellTask } from "./shell-fixture.ts";
import type { InboxSnapshot, IndexEntry } from "@otk/protocol";

Deno.test("native running descendants count across task splits independently of three blocked lamps", () => {
  const root = shellEntry("root");
  const helpers = Array.from({ length: 4 }, (_, n) => ({
    ...shellEntry(`h${n}`),
    parentID: n === 3 ? "h2" : root.id,
    activity: {
      work: {
        fresh: true,
        keys: [`run-${n}`],
        items: [{
          id: `run-${n}`,
          kind: "execution" as const,
          label: "Execution",
          title: `Helper ${n}`,
          startedAt: 100 + n,
        }],
      },
      permissions: { fresh: true, keys: n < 3 ? [`p${n}`] : [] },
    },
  }));
  const entries: IndexEntry[] = [root, ...helpers];
  const inbox: InboxSnapshot = {
    projects: [],
    pathTemplates: [],
    seen: {},
    finishes: {},
    tasks: [shellTask("parent", [root.id]), shellTask("split", ["h2"])],
    supervision: Object.fromEntries(helpers.map((h, n) => [h.id, {
      state: n < 3 ? "needsYou" : "working",
      terminal: 0,
    }])),
  };
  const tabs = createTabs(() => Promise.resolve(inbox.tasks[0]));
  tabs.update({ directory: "/p", entries, inbox, connected: true });
  tabs.preview(root.id);
  const items = () =>
    runningWork({
      tabs,
      inbox,
      sessionID: root.id,
      connected: true,
      entry: (id) => entries.find((e) => e.id === id),
    });
  assertEquals(items().map((item) => item.sessionID).toSorted(), [
    "h0",
    "h1",
    "h2",
    "h3",
  ]);
  assertEquals(runningWorkLabel(items()), "4 subagents");
  assertEquals(tabs.crumbs().some((c) => c.id === "h3"), true);
  helpers[1].activity.work.fresh = false;
  tabs.update({ directory: "/p", entries, inbox, connected: true });
  assertEquals(items().length, 3);
  tabs.preview("h2");
  assertEquals(tabs.working().map((c) => c.id), ["h3"]);
  tabs.stop();
});
