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
import type { ServerFrame } from "@otk/protocol";

Deno.test("inbox maintains committed keys without baseline SQL or unrelated payloads", async () => {
  const path = await Deno.makeTempDir();
  const db = new OtkDb(path, [
    projectsMigrations,
    tasksMigrations,
    seenMigrations,
    finishesMigrations,
    projectTemplatesMigrations,
  ]);
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
    stores.seen.mark("local", "opcv1-ses_a");
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
  ]);
  let clock = 0;
  const stores = {
    projects: new Projects(db),
    tasks: new Tasks(db),
    seen: new Seen(db, () => ++clock),
    finishes: new Finishes(db),
    templates: new ProjectTemplates(db),
  };
  for (let i = 0; i < 20; i++) stores.tasks.create("/p", `Task ${i}`, []);
  stores.seen.mark("local", "opcv1-ses_a");
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
    stores.seen.mark("local", "opcv1-ses_a");
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
