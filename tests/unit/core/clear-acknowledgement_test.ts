// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals, assertRejects } from "@std/assert";
import type { Harness } from "@otk/harness";
import { entityKey, type IndexMetadata, taskEntityID } from "@otk/protocol";
import {
  Finishes,
  finishesMigrations,
  OtkDb,
  Projects,
  projectsMigrations,
  ProjectTemplates,
  projectTemplatesMigrations,
  Seen,
  seenMigrations,
  Tasks,
  tasksMigrations,
} from "@otk/store";
import { InboxFeature } from "../../../core/features/inbox.ts";
import { IndexStore } from "../../../core/index/store.ts";
import { RpcRegistry } from "../../../core/ws/registry.ts";
import { fixture } from "../../support/config.ts";
import { ManualClock } from "../../support/manual-clock.ts";
import { test } from "../../support/resources.ts";

const root = "tstv1-main";
const task = taskEntityID("session", root);
const success = "tstv1-success";
const failure = "tstv1-failure";
const working = "tstv1-running";
const waiting = "tstv1-waiting";
const nested = "tstv1-nested";

function row(
  id: string,
  { parentID, directory = "/p", activity }: Partial<IndexMetadata> = {},
): IndexMetadata {
  return {
    id,
    directory,
    parentID,
    projectID: "p",
    title: id,
    archived: false,
    status: "idle",
    timeCreated: 1,
    timeUpdated: 20,
    attention: {
      permissions: 0,
      questions: 0,
      childPermissions: 0,
      childQuestions: 0,
    },
    activity,
  };
}

function open(directory: string, rows: IndexMetadata[]) {
  const db = new OtkDb(directory, [
    projectsMigrations,
    tasksMigrations,
    seenMigrations,
    finishesMigrations,
    projectTemplatesMigrations,
  ], { busyms: 5000 });
  const seen = new Seen(db);
  const clock = new ManualClock();
  const index = new IndexStore();
  const feature = new InboxFeature(
    {
      projects: new Projects(db),
      tasks: new Tasks(db),
      seen,
      finishes: new Finishes(db),
      templates: new ProjectTemplates(db),
    },
    index,
    "alice",
    () => Promise.resolve([]),
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    clock,
  );
  const rpc = new RpcRegistry({
    core: {
      identities: (ids: readonly string[]) =>
        Promise.resolve(rows.filter(({ id }) => ids.includes(id))),
    },
  } as unknown as Harness, db);
  feature.register(rpc);
  index.reset(rows);
  return {
    rpc,
    seen,
    index,
    clock,
    helpers: () => feature.states.get(entityKey("task", task))?.helpers,
    state: (id: string) => feature.states.get(entityKey("session", id)),
    close() {
      feature.close();
      db.close();
    },
  };
}

const run = (terminal: number) => ({ terminal, outcome: "succeeded" as const });
const deliveredFailure = row(failure, {
  parentID: root,
  activity: {
    terminal: 22,
    outcome: "failed",
    delivered: { parentID: root, receipt: "error", terminal: 22 },
  },
});

test("D72 helpers acknowledge the published roster once and a newer run returns after restart", async () => {
  const directory = await fixture();
  const completed = row(success, { parentID: root, activity: run(20) });
  const rows = [
    row(root),
    completed,
    deliveredFailure,
    row(working, {
      parentID: root,
      activity: { ...run(18), work: { fresh: true, keys: ["run"] } },
    }),
    row(waiting, {
      parentID: root,
      activity: { ...run(19), inputs: { fresh: true, keys: ["question"] } },
    }),
  ];
  let f = open(directory, rows);
  try {
    const params = { scope: "helpers", task };
    assertEquals<unknown>(f.helpers()?.counts, {
      running: 1,
      needsYou: 1,
      finished: 2,
    });
    assertEquals(await f.rpc.dispatch("sessions.acknowledge", params), {
      sessions: [
        { sessionID: failure, terminal: 22 },
        { sessionID: success, terminal: 20 },
      ],
    });
    assertEquals(f.helpers()?.ids, [working, waiting]);
    assertEquals(f.state(working)?.counts.unseen, 1);
    assertEquals(f.state(waiting)?.counts.unseen, 1);
    assertEquals(await f.rpc.dispatch("sessions.acknowledge", params), {
      sessions: [],
    });
    f.close();
    f = open(directory, rows);
    assertEquals(f.helpers()?.ids, [working, waiting]);
    assertEquals<unknown>(f.helpers()?.counts, {
      running: 1,
      needsYou: 1,
      finished: 0,
    });
    f.index.upsert({ ...completed, activity: run(23) });
    assertEquals(f.helpers()?.ids, [working, waiting, success]);
    assertEquals<unknown>(f.helpers()?.counts, {
      running: 1,
      needsYou: 1,
      finished: 1,
    });
    await assertRejects(
      () =>
        f.rpc.dispatch("sessions.seen", { sessionID: success, terminal: 24 }),
      Error,
      "Terminal token was not published",
    );
    assertEquals(f.state(success)?.counts.unseen, 1);
    await f.rpc.dispatch("sessions.seen", { sessionID: success, terminal: 23 });
    assertEquals(f.state(success)?.evidence?.helper, undefined);
    assertEquals(f.helpers()?.ids, [working, waiting]);
    assertEquals(f.seen.tokens().find((e) => e.session === success)?.time, 23);
  } finally {
    f.close();
  }
});

test("subtree acknowledgement covers its own run and all checkouts without settling a live permission", async () => {
  const f = open(await fixture(), [
    row(root, { activity: run(10) }),
    deliveredFailure,
    row(nested, {
      parentID: failure,
      directory: "/p-checkout",
      activity: {
        ...run(24),
        permissions: { fresh: true, keys: ["permission"] },
      },
    }),
    row("tstv1-other-root", { activity: run(25) }),
  ]);
  try {
    f.clock.runNext();
    assertEquals(f.state(nested)?.cause, "permission");
    const result = await f.rpc.dispatch("sessions.acknowledge", {
      scope: "subtree",
      sessionID: root,
    }) as { sessions: { sessionID: string; terminal: number }[] };
    assertEquals(
      new Map(result.sessions.map((e) => [e.sessionID, e.terminal])),
      new Map([[root, 10], [failure, 22], [nested, 24]]),
    );
    assertEquals(f.state(root)?.counts.unseen, 0);
    assertEquals(f.state(root)?.evidence?.descendants.unseen, 0);
    assertEquals(f.state(failure)?.outcome, "failed");
    assertEquals(f.state(nested)?.cause, "permission");
    assertEquals(f.state(nested)?.state, "blocked");
    assertEquals(f.state("tstv1-other-root")?.counts.unseen, 1);
  } finally {
    f.close();
  }
});
