// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals, assertRejects, assertThrows } from "@std/assert";
import { DatabaseSync } from "node:sqlite";
import type { Harness } from "@otk/harness";
import { DigestNativeDb } from "@otk/harness-opencode-v1";
import { V2NativeDb } from "@otk/harness-opencode-v2-server";
import {
  entityKey,
  type IndexMetadata,
  latestTerminal,
  taskEntityID,
} from "@otk/protocol";
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
  feature.approvalAttention(
    (id) => index.getMetadata(id)?.activity?.permissions?.keys.length ?? 0,
    () => () => {},
  );
  index.projectAuthority("current");
  index.reset(rows);
  return {
    rpc,
    seen,
    index,
    clock,
    baseline: () => feature.baseline(),
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

test("pre-run-key acknowledgements survive the upgrade without covering a successor", async () => {
  const directory = await fixture();
  const legacy = new OtkDb(directory, [{
    ...seenMigrations,
    migrations: seenMigrations.migrations.filter(({ version }) => version < 4),
  }], { busyms: 5000 });
  try {
    // These are the exact columns written by the old Seen owner. The new
    // setOpened writer requires a column absent from the previous schema.
    legacy.connection.exec(
      `INSERT INTO session_seen(user,session,time,terminal,opened) VALUES
      ('alice','${failure}',0,20,0), ('alice','${success}',9,20,1),
      ('bob','${failure}',0,19,0), ('bob','${success}',0,20,0);`,
    );
  } finally {
    legacy.close();
  }
  const historical = {
    ...run(20),
    terminalOrigin: "historical" as const,
    runID: "r1",
    legacyAcknowledgement: { terminal: 20, runID: "r1" },
  };
  const cleared = row(failure, {
    parentID: root,
    activity: {
      ...historical,
      outcome: "failed",
      delivered: { parentID: root, terminal: 18, receipt: "old", runID: "r0" },
    },
  });
  const retained = row(success, { parentID: root, activity: historical });
  const question = row("tstv1-genuine-question", { directory: "/questions" });
  const permission = row("tstv1-genuine-permission", {
    directory: "/permissions",
  });
  const uncovered = row("tstv1-uncovered", {
    directory: "/uncovered",
    activity: { ...run(25), outcome: "failed" },
  });
  question.attention.questions = 1;
  permission.attention.permissions = 1;
  question.activity = { inputs: { keys: ["question"], fresh: true } };
  permission.activity = { permissions: { keys: ["permission"], fresh: true } };
  const f = open(directory, [
    row(root),
    cleared,
    retained,
    question,
    permission,
    uncovered,
  ]);
  try {
    assertEquals(f.state(failure)?.state, "none");
    assertEquals(f.state(failure)?.outcome, "failed");
    assertEquals(f.state(success)?.evidence?.helper, "opened");
    assertEquals(f.helpers()?.counts, {
      needsYou: 0,
      running: 0,
      finished: 0,
      opened: 1,
    });
    f.clock.runNext(); // The genuine permission crosses the normal grace window.
    const { summaries } = (await f.baseline()).inbox;
    const summary = summaries?.["/p"];
    assertEquals([summary?.status, summary?.unseenCount], ["none", 0]);
    assertEquals(
      ["/questions", "/permissions", "/uncovered"].map((key) =>
        summaries?.[key]?.status
      ),
      ["blocked", "blocked", "blocked"],
    );
    assertEquals(f.seen.runTerminal("alice", failure, "r1"), 20);
    assertEquals(f.seen.runTerminal("bob", failure, "r1"), 0);
    assertEquals(f.seen.runTerminal("bob", success, "r1"), 20);
    assertEquals(f.seen.time("alice", failure), 0);
    assertEquals(f.seen.time("alice", success), 9);
    assertEquals(f.seen.openGeneration("alice", success), 0);
    const successor = { ...historical, runID: "r2" };
    f.index.upsert({
      ...cleared,
      activity: latestTerminal(historical, successor),
    });
    assertEquals(f.state(failure)?.counts.unseen, 1);
    // Even if later history now proves only R2, R1 spent this legacy token.
    f.index.upsert({
      ...cleared,
      activity: {
        ...successor,
        legacyAcknowledgement: { terminal: 20, runID: "r2" },
      },
    });
    assertEquals(f.state(failure)?.counts.unseen, 1);
  } finally {
    f.close();
  }
  const noProof = { ...historical, legacyAcknowledgement: undefined };
  const restarted = open(directory, [
    row(root),
    { ...cleared, activity: noProof },
    retained,
  ]);
  try {
    assertEquals(restarted.state(failure)?.counts.unseen, 0);
    assertEquals(restarted.state(success)?.evidence?.helper, "opened");
  } finally {
    restarted.close();
  }
});

test("scalar native history proves the exact run, not an equal-clock winner", async () => {
  const directory = await fixture();
  const file = `${directory}/native.sqlite`;
  const writer = new DatabaseSync(file);
  try {
    writer.exec(`
      CREATE TABLE project(id TEXT,worktree TEXT);
      CREATE TABLE session(id TEXT,parent_id TEXT,directory TEXT,project_id TEXT,title TEXT,time_created INTEGER,time_updated INTEGER,time_archived INTEGER);
      CREATE TABLE message(id TEXT,session_id TEXT,time_created INTEGER,data TEXT);
      CREATE TABLE part(id TEXT,message_id TEXT,session_id TEXT,data TEXT);
      CREATE TABLE session_v2(id TEXT,project_id TEXT,directory TEXT,parent_id TEXT,time_created INTEGER,time_updated INTEGER,time_idle INTEGER,idle_outcome TEXT);
      CREATE TABLE session_message(id TEXT,session_id TEXT,seq INTEGER,type TEXT,time_created INTEGER,data TEXT);
      INSERT INTO session VALUES('ses_v1',NULL,'/v1','v1','V1',1,20,NULL);
      INSERT INTO message VALUES('v1-older','ses_v1',8,'{"role":"assistant","time":{"completed":10}}'),
        ('v1-end','ses_v1',18,'{"role":"assistant","time":{"completed":20}}'),
        ('v1-tool','ses_v1',19,'{"role":"assistant","time":{"completed":20},"finish":"tool-calls"}');
      INSERT INTO session_v2 VALUES('ses_v2','v2','/v2','ses_v2_parent',1,20,20,'failed');
      INSERT INTO session_message VALUES('v2-older','ses_v2',1,'idle',10,'{"outcome":"succeeded"}'),
        ('v2-end','ses_v2',2,'idle',20,'{"outcome":"failed"}');
    `);
    const nativeV1 = new DigestNativeDb(file);
    let nativeV2: V2NativeDb | undefined;
    try {
      const db = nativeV2 = new V2NativeDb(file);
      const current = () => [
        nativeV1.terminals("", 1)[0],
        db.terminals("", 1)[0],
      ];
      const unique = current();
      assertEquals(
        unique.map(({ activity }) => activity?.legacyAcknowledgement),
        [{ terminal: 20, runID: "v1-end" }, { terminal: 20, runID: "v2-end" }],
      );
      const v2 = unique[1];
      assertEquals(
        db.facts([v2.id])[0].legacyAcknowledgement,
        v2.activity?.legacyAcknowledgement,
      );
      assertEquals(
        db.lookup([v2.id])[0].activity?.legacyAcknowledgement,
        v2.activity?.legacyAcknowledgement,
      );
      const restored = open(await fixture(), []);
      try {
        for (const entry of unique) {
          restored.seen.acknowledge("alice", entry.id, 20);
          restored.index.upsert(entry);
          assertEquals(restored.state(entry.id)?.counts.unseen, 0);
        }
        const { inbox } = await restored.baseline();
        assertEquals(
          ["/v1", "/v2"].map((key) => inbox.summaries?.[key]?.unseenCount),
          [0, 0],
        );
      } finally {
        restored.close();
      }
      writer.exec(`
        INSERT INTO message VALUES('v1-tie','ses_v1',20,'{"role":"assistant","error":{"name":"APIError"}}');
        INSERT INTO session_message VALUES('v2-tie','ses_v2',3,'idle',20,'{"outcome":"succeeded"}');
      `);
      const ambiguous = current();
      assertEquals(ambiguous.map(({ activity }) => activity?.runID), [
        "v1-tie",
        "v2-end",
      ]);
      assertEquals(
        ambiguous.map(({ activity }) => activity?.legacyAcknowledgement),
        [null, null],
      );
      // A matching visit clock without a terminal token is not a legacy clear.
      const f = open(directory, []);
      try {
        for (const entry of ambiguous) {
          f.seen.acknowledge("alice", entry.id, 20);
          f.index.upsert(entry);
          assertEquals(f.state(entry.id)?.counts.unseen, 1);
        }
        const miss = row("tstv1-visit-only", {
          activity: unique[0].activity,
        });
        new Seen(f.seen.db, () => 20).mark("alice", miss.id);
        f.index.upsert(miss);
        assertEquals(f.state(miss.id)?.counts.unseen, 1);
        const live = row("tstv1-live", {
          activity: latestTerminal(unique[0].activity, {
            ...unique[0].activity,
            terminalOrigin: "live",
          }),
        });
        f.seen.acknowledge("alice", live.id, 20);
        f.index.upsert(live);
        assertEquals(f.state(live.id)?.counts.unseen, 1);
      } finally {
        f.close();
      }
    } finally {
      nativeV2?.close();
      nativeV1.close();
    }
  } finally {
    writer.close();
  }
});

test("legacy Seen binding joins its write and does not emit a Seen event", async () => {
  const f = open(await fixture(), []);
  try {
    const seen = f.seen;
    const calls: string[] = [];
    seen.acknowledge("alice", root, 20);
    const stop = seen.listen(({ session }) => calls.push(session));
    assertThrows(
      () =>
        seen.db.write((tx) => {
          seen.bindLegacyTerminal(root, 20, "exact", tx);
          assertEquals(seen.runTerminal("alice", root, "exact"), 20);
          throw new Error("roll back");
        }),
      Error,
      "roll back",
    );
    assertEquals(seen.runTerminal("alice", root, "exact"), 0);
    seen.db.write((tx) => seen.bindLegacyTerminal(root, 20, "exact", tx));
    seen.bindLegacyTerminal(root, 20, "exact");
    assertEquals(seen.runTerminal("alice", root, "exact"), 20);
    assertEquals(calls, []);
    stop();
  } finally {
    f.close();
  }
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
