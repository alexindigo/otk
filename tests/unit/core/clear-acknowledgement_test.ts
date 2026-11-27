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

function open(
  directory: string,
  rows: IndexMetadata[],
  beforeIdentities: () => Promise<void> | void = () => {},
) {
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
      identities: async (ids: readonly string[]) => {
        await beforeIdentities();
        return rows.filter(({ id }) => ids.includes(id));
      },
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

test("a newer explicit Open survives older Clear and a newer run remains unseen", async () => {
  const entered = Promise.withResolvers<void>();
  const validate = Promise.withResolvers<void>();
  let holdNext = false;
  const helper = row(success, {
    parentID: root,
    activity: { ...run(20), runID: "run-2" },
  });
  const f = open(await fixture(), [row(root), helper], () => {
    if (!holdNext) return;
    holdNext = false;
    entered.resolve();
    return validate.promise;
  });
  try {
    const opened = { sessionID: success, opened: true };
    await f.rpc.dispatch("sessions.opened", opened);
    holdNext = true;
    const oldClear = f.rpc.dispatch("sessions.acknowledge", {
      scope: "helpers",
      task,
    });
    try {
      await entered.promise;
      await f.rpc.dispatch("sessions.opened", opened);
      // Same millisecond as R2: only the captured run identity separates them.
      f.index.upsert({ ...helper, activity: { ...run(20), runID: "run-3" } });
    } finally {
      validate.resolve();
      await oldClear;
    }
    assertEquals(f.state(success)?.runID, "run-3");
    assertEquals(f.state(success)?.counts.unseen, 1);
    assertEquals(f.state(success)?.opened, true);
  } finally {
    f.close();
  }
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
      finished: 1,
    });
    assertEquals(await f.rpc.dispatch("sessions.acknowledge", params), {
      sessions: [
        { sessionID: success, terminal: 20 },
      ],
    });
    // D78 changes the roster's group order, not what acknowledgement clears.
    assertEquals(f.helpers()?.ids, [waiting, working]);
    assertEquals(f.state(working)?.counts.unseen, 1);
    assertEquals(f.state(waiting)?.counts.unseen, 1);
    assertEquals(await f.rpc.dispatch("sessions.acknowledge", params), {
      sessions: [],
    });
    f.close();
    f = open(directory, rows);
    assertEquals(f.helpers()?.ids, [waiting, working]);
    assertEquals<unknown>(f.helpers()?.counts, {
      running: 1,
      needsYou: 1,
      finished: 0,
    });
    f.index.upsert({ ...completed, activity: run(23) });
    assertEquals(f.helpers()?.ids, [waiting, success, working]);
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
    assertEquals(f.helpers()?.ids, [waiting, working]);
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
      new Map([[root, 10], [nested, 24]]),
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

test("closing a task clears explicit opens for all its members without acknowledging finishes", async () => {
  const directory = await fixture();
  const second = "tstv1-second", other = "tstv1-other-root";
  const rows = [
    row(root, { activity: run(10) }),
    deliveredFailure,
    row(nested, { parentID: failure, directory: "/p-checkout" }),
    row(second, { activity: run(21) }),
    row(other),
  ];
  const members = [root, failure, nested, second];
  let f = open(directory, rows);
  try {
    const task = await f.rpc.dispatch("tasks.create", {
      directory: "/p",
      name: "Close this task",
      sessions: [root, second],
    }) as { id: string };
    await f.rpc.dispatch("sessions.seen", { sessionID: root, terminal: 10 });
    for (const sessionID of [...members, other]) {
      await f.rpc.dispatch("sessions.opened", { sessionID, opened: true });
      assertEquals(f.state(sessionID)?.opened, true, sessionID);
    }
    f.seen.setOpened("bob", nested, true);
    await f.rpc.dispatch("tasks.close", { id: task.id });
    for (const id of members) assertEquals(f.state(id)?.opened, undefined, id);
    assertEquals(f.state(other)?.opened, true);
    assertEquals(f.state(second)?.counts.unseen, 1);
    f.close();
    f = open(directory, rows);
    assertEquals(
      f.seen.tokens().filter((record) => record.opened).map(
        ({ user, session }) => [user, session],
      ),
      [["alice", other], ["bob", nested]],
    );
    assertEquals(
      f.seen.tokens().find(({ user, session }) =>
        user === "alice" && session === root
      )?.time,
      10,
    );
  } finally {
    f.close();
  }
});
