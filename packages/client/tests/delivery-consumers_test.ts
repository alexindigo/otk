// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals } from "@std/assert";
import {
  createEntityStateStore,
  createTabs,
  entityFacts,
  inboxStatus,
  lamp,
  NotificationTriggers,
  unread,
} from "@otk/client";
import type { InboxSnapshot, IndexEntry } from "@otk/protocol";
import { SessionSupervision } from "../../../core/index/supervision.ts";
import { ProjectSummaries } from "../../../core/index/project-summaries.ts";
import { shellEntry, shellFixture } from "./shell-fixture.ts";

Deno.test("delivered helper shares unseen across rollup, name, family, navigation status and Activity lamp", () => {
  const owner = new SessionSupervision(),
    root = shellEntry("root"),
    helper = shellEntry("helper", "/p", "root");
  helper.activity = {
    terminal: 100,
    outcome: "succeeded",
    delivered: { parentID: "root", receipt: "result", terminal: 100 },
  };
  const inbox: InboxSnapshot = {
    projects: [],
    tasks: [],
    pathTemplates: [],
    seen: {},
    finishes: { helper: 100 },
    supervision: { helper: owner.session(helper, 0) },
  };
  assertEquals(unread(helper, inbox), false);
  assertEquals(inboxStatus(helper, inbox), "none");
  const summaries = new ProjectSummaries(
    () => ({ seen: 0, finish: 100 }),
    () => {},
  );
  summaries.authority("current");
  summaries.seed([{
    directory: "/p",
    hasSessions: true,
    sessionCount: 1,
    lastActivity: 100,
    authority: "current",
  }]);
  summaries.entry(helper);
  const entities = createEntityStateStore({
    read: () => Object.fromEntries(summaries.states.values()),
  });
  assertEquals(
    lamp(
      entityFacts({ sessionID: "helper" }, { session: () => ({}), entities })
        .session.entities!,
      "session:helper",
      { now: 0 },
    ),
    "none",
  );
  entities.stop();
  assertEquals(summaries.values.get("/p")?.unseenCount, 0);
  const tabs = createTabs(() => Promise.reject(new Error("No promotion")));
  tabs.update({ directory: "/p", entries: [root, helper], inbox });
  tabs.preview("root");
  assertEquals(tabs.crumbs().map((c) => c.id), ["root"]);
  tabs.preview("helper");
  assertEquals(tabs.path().map((c) => c.id), ["root", "helper"]);
  helper.activity.work = { keys: ["resumed"], fresh: true };
  helper.activity.terminal = 200;
  inbox.supervision!.helper = owner.session(helper, 0);
  assertEquals(unread(helper, inbox), true);
  assertEquals(inboxStatus(helper, inbox), "working");
  tabs.stop();
});

Deno.test("equal-terminal acknowledgement retracts helper notification without alerting on eligibility replay", () => {
  const f = shellFixture(), notes: string[] = [], retractions: string[] = [];
  const triggers = new NotificationTriggers(
    (n) => notes.push(n.kind),
    (id) => retractions.push(id),
  );
  f.resources.observeEntries(
    "local",
    (change) => triggers.entriesChanged("local", change),
  );
  const helper: IndexEntry = {
    ...shellEntry("helper", "/p", "root"),
    activity: { terminal: 0 },
  };
  f.resources.receive("local", {
    t: "index.snapshot",
    rev: 0,
    entries: [helper],
  });
  f.resources.receive("local", {
    t: "inbox.snapshot",
    generation: "delivery",
    revision: 0,
    inbox: {
      projects: [],
      tasks: [],
      pathTemplates: [],
      seen: {},
      finishes: {},
    },
  });
  const owner = new SessionSupervision();
  helper.activity = {
    terminal: 100,
    outcome: "succeeded",
    terminalOrigin: "live",
  };
  let revision = 0;
  const publish = () =>
    f.resources.receive("local", {
      t: "inbox.patch",
      generation: "delivery",
      from: revision,
      revision: revision += 2,
      ops: [{
        op: "supervision",
        sessionID: "helper",
        value: owner.session(helper, 0),
      }, { op: "finish", sessionID: "helper", time: 100 }],
    });
  publish();
  assertEquals(notes, ["done"]);
  helper.activity!.delivered = {
    parentID: "root",
    receipt: "report",
    terminal: 100,
  };
  publish();
  assertEquals(notes, ["done"]);
  assertEquals(retractions.length, 1);
  helper.activity!.delivered = undefined;
  publish();
  assertEquals(notes, ["done"]);
  triggers.stop();
  f.resources.stop();
});
