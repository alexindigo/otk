// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals } from "@std/assert";
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
import type { IndexMetadata, ServerFrame, ViewLease } from "@otk/protocol";
import { createInbox, createTabs, Rpc } from "@otk/client";

Deno.test("family metadata leases include cross-checkout failures and inputs, but not delivered successes or unrelated sessions", async () => {
  const path = await Deno.makeTempDir();
  const db = new OtkDb(path, [
    projectsMigrations,
    tasksMigrations,
    seenMigrations,
    finishesMigrations,
    projectTemplatesMigrations,
  ], { busyms: 5000 });
  const stores = {
    projects: new Projects(db),
    tasks: new Tasks(db),
    seen: new Seen(db),
    finishes: new Finishes(db),
    templates: new ProjectTemplates(db),
  };
  const index = new IndexStore();
  const feature = new InboxFeature(
    stores,
    index,
    "local",
    () => Promise.resolve([]),
  );
  const row = (
    id: string,
    directory: string,
    parentID?: string,
  ): IndexMetadata => ({
    id,
    directory,
    parentID,
    projectID: "p",
    title: id,
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
  try {
    index.upsertMetadata(row("tstv1-human", "/repo"));
    index.upsertMetadata({
      ...row("tstv1-failed", "/tree", "tstv1-human"),
      activity: { terminal: 10, outcome: "failed" },
    });
    index.upsertMetadata({
      ...row("tstv1-question", "/tree", "tstv1-human"),
      activity: { inputs: { keys: ["question"], fresh: true } },
    });
    index.upsertMetadata({
      ...row("tstv1-delivered", "/tree", "tstv1-human"),
      activity: {
        terminal: 10,
        outcome: "succeeded",
        delivered: { parentID: "tstv1-human", receipt: "report", terminal: 10 },
      },
    });
    index.upsertMetadata({
      ...row("tstv1-unrelated", "/away"),
      activity: { terminal: 10, outcome: "failed" },
    });
    assertEquals(
      feature.keys({
        epoch: 1,
        directory: "/repo",
        selected: "tstv1-human",
        rows: [],
        crumbs: [],
      }).sort(),
      ["tstv1-failed", "tstv1-question"],
    );
  } finally {
    feature.close();
    db.close();
    await Deno.remove(path, { recursive: true });
  }
});

Deno.test("inbox admission reconciliation flushes queued live finishes before replay", async () => {
  const path = await Deno.makeTempDir();
  const db = new OtkDb(path, [
    projectsMigrations,
    tasksMigrations,
    seenMigrations,
    finishesMigrations,
    projectTemplatesMigrations,
  ], { busyms: 5000 });
  const stores = {
    projects: new Projects(db),
    tasks: new Tasks(db),
    seen: new Seen(db),
    finishes: new Finishes(db),
    templates: new ProjectTemplates(db),
  };
  const index = new IndexStore();
  const id = "tstv1-live";
  index.upsertMetadata({
    id,
    directory: "/p",
    projectID: "p",
    title: id,
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
  stores.finishes.observe(id, 10);
  const feature = new InboxFeature(
    stores,
    index,
    "local",
    () => Promise.resolve([]),
  );
  const projection = feature.open(
    () => ({ epoch: 1, directory: "/p", rows: [id], crumbs: [] }),
    "connection",
    () => new Set([id]),
  );
  const frames: ServerFrame[] = [];
  const stop = projection.listen((frame) => frames.push(frame));
  try {
    await projection.snapshot!();
    projection.entriesChanged?.();
    stores.finishes.observe(id, 20);
    await new Promise((resolve) => setTimeout(resolve, 0));
    const finishes = frames.filter((frame) => frame.t === "inbox.patch")
      .flatMap((frame) =>
        frame.ops.filter((op) => op.op === "finish" && op.time === 20)
          .map(() => ({ admitted: !!frame.admitted }))
      );
    assertEquals(
      finishes,
      [{ admitted: false }],
      "Live finishes cannot be consumed as admission facts",
    );
  } finally {
    stop();
    projection.close?.();
    feature.close();
    db.close();
    await Deno.remove(path, { recursive: true });
  }
});

Deno.test("inbox maintains committed keys without baseline SQL or unrelated payloads", async () => {
  const path = await Deno.makeTempDir();
  const db = new OtkDb(path, [
    projectsMigrations,
    tasksMigrations,
    seenMigrations,
    finishesMigrations,
    projectTemplatesMigrations,
  ], { busyms: 5000 });
  const stores = {
    projects: new Projects(db),
    tasks: new Tasks(db),
    seen: new Seen(db),
    finishes: new Finishes(db),
    templates: new ProjectTemplates(db),
  };
  stores.projects.add("local", "/p");
  stores.tasks.create("/p", "Unrelated", []);
  const inbox = new InboxFeature(
    stores,
    new IndexStore(),
    "local",
    () => Promise.resolve([]),
  );
  const frames: ServerFrame[] = [];
  inbox.listen((frame) => frames.push(frame));
  await inbox.snapshot();
  await new Promise((yes) => setTimeout(yes, 0));
  frames.length = 0;
  const prepare = db.connection.prepare.bind(db.connection);
  const selects: string[] = [];
  db.connection.prepare = ((sql: string) => {
    if (/^\s*SELECT/i.test(sql)) selects.push(sql);
    return prepare(sql);
  }) as typeof db.connection.prepare;
  try {
    stores.seen.acknowledge("local", "opcv1-ses_a", 1);
    await new Promise((yes) => setTimeout(yes, 0));
    assertEquals(selects, []);
    assertEquals(frames.length, 1);
    const frame = frames[0];
    assertEquals(frame.t, "inbox.patch");
    if (frame.t !== "inbox.patch") throw new Error("Expected keyed patch");
    assertEquals(frame.ops.map((op) => op.op), ["seen"]);
    assertEquals(frame.revision, frame.from + 1);
    assertEquals(inbox.get().tasks[0].name, "Unrelated");
    assertEquals(selects, []);
  } finally {
    inbox.close();
    db.close();
    await Deno.remove(path, { recursive: true });
  }
});

Deno.test("bounded inbox baseline completes while committed marks keep changing", async () => {
  const path = await Deno.makeTempDir();
  const db = new OtkDb(path, [
    projectsMigrations,
    tasksMigrations,
    seenMigrations,
    finishesMigrations,
    projectTemplatesMigrations,
  ], { busyms: 5000 });
  let clock = 0;
  const stores = {
    projects: new Projects(db),
    tasks: new Tasks(db),
    seen: new Seen(db, () => ++clock),
    finishes: new Finishes(db),
    templates: new ProjectTemplates(db),
  };
  for (let i = 0; i < 20; i++) stores.tasks.create("/p", `Task ${i}`, []);
  stores.seen.acknowledge("local", "opcv1-ses_a", ++clock);
  const inbox = new InboxFeature(
    stores,
    new IndexStore(),
    "local",
    () => Promise.resolve([]),
    undefined,
    1,
  );
  const controller = new AbortController();
  const timer = setInterval(() => {
    stores.seen.acknowledge("local", "opcv1-ses_a", ++clock);
  }, 1);
  let deadline: ReturnType<typeof setTimeout> | undefined;
  try {
    const value = await Promise.race([
      inbox.baseline(controller.signal),
      new Promise<never>((_resolve, reject) => {
        deadline = setTimeout(
          () => reject(new Error("Baseline waits for mark traffic to stop")),
          1000,
        );
      }),
    ]);
    assertEquals(value.inbox.tasks.length, 20);
    assertEquals(value.inbox.seen["opcv1-ses_a"], clock);
    assertEquals(clock > 1, true);
  } finally {
    clearInterval(timer);
    clearTimeout(deadline);
    controller.abort();
    inbox.close();
    db.close();
    await Deno.remove(path, { recursive: true });
  }
});

for (const changedID of ["tstv1-child", "tstv1-bridge"]) {
  Deno.test(`connection task projection replays inherited membership after ${changedID} changes and view replacement`, async () => {
    const path = await Deno.makeTempDir();
    const db = new OtkDb(path, [
      projectsMigrations,
      tasksMigrations,
      seenMigrations,
      finishesMigrations,
      projectTemplatesMigrations,
    ], { busyms: 5000 });
    const stores = {
      projects: new Projects(db),
      tasks: new Tasks(db),
      seen: new Seen(db),
      finishes: new Finishes(db),
      templates: new ProjectTemplates(db),
    };
    const index = new IndexStore();
    const row = (
      id: string,
      directory: string,
      parentID?: string,
    ): IndexMetadata => ({
      id,
      directory,
      parentID,
      title: id,
      projectID: directory,
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
    const root = row("tstv1-root", "/foreign"),
      bridge = row("tstv1-bridge", "/foreign");
    const child = row(
      "tstv1-child",
      "/p",
      changedID === bridge.id ? bridge.id : undefined,
    );
    for (const entry of [root, bridge, child]) index.upsertMetadata(entry);
    const task = stores.tasks.create(root.directory, "Existing foreign task", [
      root.id,
    ]);
    const feature = new InboxFeature(
      stores,
      index,
      "local",
      () => Promise.resolve([]),
    );
    const view: ViewLease = {
      epoch: 1,
      directory: child.directory,
      rows: [child.id],
      crumbs: [],
      tasksFollowParent: true,
    };
    const projection = feature.open(
      () => view,
      "connection",
      () => new Set([child.id]),
    );
    const rpc = new Rpc(() => {}), consumer = createInbox(rpc);
    const tabs = createTabs(() => Promise.reject(new Error("No promotion")));
    const frames: ServerFrame[] = [];
    const reduce = (frame: ServerFrame) => {
      frames.push(frame);
      consumer.receive(frame);
      tabs.update({
        directory: child.directory,
        entries: [index.getMetadata(child.id)!],
        context: [root, bridge, child].map((entry) =>
          index.getMetadata(entry.id)!
        ),
        followParent: view.tasksFollowParent,
        inbox: consumer.state.inbox,
      });
    };
    const stop = projection.listen(reduce),
      tick = () => new Promise((resolve) => setTimeout(resolve, 0));
    try {
      reduce(await projection.snapshot!());
      assertEquals(consumer.state.inbox.tasks, []);
      const ready = tabs.taskReady(task.id);
      index.upsertMetadata({
        ...index.getMetadata(changedID)!,
        parentID: root.id,
      });
      await tick();
      assertEquals(
        consumer.state.inbox.tasks.map((task) => task.id),
        [task.id],
        "existing task must arrive without a later task mutation",
      );
      assertEquals(await ready, true);
      stores.tasks.rename(task.id, "Renamed foreign task");
      await tick();
      assertEquals(consumer.state.inbox.tasks[0].name, "Renamed foreign task");
      index.upsertMetadata({
        ...index.getMetadata(changedID)!,
        parentID: undefined,
      });
      await tick();
      assertEquals(
        consumer.state.inbox.tasks,
        [],
        "departed inherited tasks must be removed",
      );
      index.upsertMetadata({
        ...index.getMetadata(changedID)!,
        parentID: root.id,
      });
      await tick();
      view.tasksFollowParent = false;
      projection.viewChanged?.();
      await tick();
      assertEquals(
        consumer.state.inbox.tasks,
        [],
        "changed views retire their old task projection",
      );
      view.tasksFollowParent = true;
      projection.viewChanged?.();
      await tick();
      assertEquals(consumer.state.inbox.tasks.map((task) => task.id), [
        task.id,
      ]);
      for (const frame of frames) {
        if (frame.t === "inbox.patch") {
          assertEquals(frame.revision, frame.from + frame.ops.length);
        }
      }
    } finally {
      stop();
      tabs.stop();
      consumer.stop();
      rpc.close();
      projection.close?.();
      feature.close();
      db.close();
      await Deno.remove(path, { recursive: true });
    }
  });
}
