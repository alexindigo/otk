// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals } from "@std/assert";
import { createTabs } from "@otk/client";
import { entityKey, type InboxSnapshot } from "@otk/protocol";
import { shellEntry } from "./shell-fixture.ts";
import { SessionSupervision } from "../../../core/index/supervision.ts";
import { EntityStates } from "../../../core/index/entity-states.ts";

Deno.test("D67 D66 D3 4.2 D58: ancestry and helpers use entity delivery and work, not titles or native status", () => {
  const root = shellEntry("root"),
    active = shellEntry("active", "/p", "root"),
    nested = shellEntry("nested", "/p", "active");
  const entries = [
    root,
    active,
    nested,
    shellEntry("other"),
    shellEntry("foreign", "/p", "other"),
    ...Array.from(
      { length: 60 },
      (_, n) => ({
        ...shellEntry(`cont-${n}`, "/p", "root"),
        title: `communico backup-restore (cont. ${n})`,
      }),
    ),
  ];
  for (const entry of entries) {
    entry.activity = entry.id.startsWith("cont-")
      ? {
        terminal: 100,
        outcome: "succeeded",
        ...(entry.id === "cont-1" ? {} : {
          delivered: { parentID: "root", receipt: "result", terminal: 100 },
        }),
      }
      : ["active", "nested", "foreign"].includes(entry.id)
      ? {
        work: {
          fresh: true,
          keys: [entry.id],
          items: [{
            id: entry.id,
            kind: "execution",
            label: "Execution",
            title: entry.id,
            startedAt: 10,
          }],
        },
      }
      : {};
  }
  const owner = new EntityStates(new SessionSupervision(), {
    getMetadata: (id) => entries.find((entry) => entry.id === id),
    ancestors: (id) =>
      id === "nested"
        ? ["active", "root"]
        : entries.find((entry) => entry.id === id)?.parentID
        ? [entries.find((entry) => entry.id === id)!.parentID!]
        : [],
    descendants: (id) =>
      new Set(
        id === "root"
          ? entries.filter((entry) =>
            entry.parentID === "root" || entry.id === "nested"
          ).map((entry) => entry.id)
          : id === "active"
          ? ["nested"]
          : [],
      ),
  }, () => {});
  // D72: explicitly seen helpers leave the list even without parent delivery.
  for (const entry of entries) owner.session(entry, 100);
  const inbox: InboxSnapshot = {
    projects: [],
    tasks: [],
    seen: { "cont-1": 100 },
    finishes: {},
    pathTemplates: [],
    entities: Object.fromEntries(owner.values()),
  };
  const tabs = createTabs(() => Promise.reject(new Error("No promotion")));
  tabs.update({ directory: "/p", entries, inbox });
  tabs.preview("nested");
  assertEquals(
    tabs.crumbs().map((crumb) => [crumb.id, crumb.depth]),
    [["root", 0], ["active", 1], ["nested", 2]],
  );
  assertEquals(
    inbox.entities![entityKey("session", "cont-0")].counts.unseen,
    0,
  );
  assertEquals(
    inbox.entities![entityKey("session", "cont-1")].evidence!.helper,
    undefined,
  );
  assertEquals(tabs.trail().task, "task:session/root");
  assertEquals(
    inbox.entities![entityKey("session", "nested")].evidence?.run,
    { startedAt: 10 },
  );
  assertEquals(inbox.entities![tabs.trail().task!].helpers?.ids, [
    "active",
    "nested",
  ]);
  tabs.stop();
});
