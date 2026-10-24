// SPDX-License-Identifier: LGPL-3.0-only
import { test } from "../../support/resources.ts";
import { assertEquals } from "@std/assert";
import { join } from "@std/path";
import { fixture } from "../../support/config.ts";
import { scanProjects } from "../../../core/features/project-scan.ts";
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

test("template discovery excludes linked worktrees but retains ordinary directories and git-file submodules", async () => {
  const root = await fixture();
  for (const name of ["main", "linked", "plain", "module"]) {
    await Deno.mkdir(join(root, name));
  }
  const metadata = join(root, "main", ".git", "worktrees", "linked");
  await Deno.mkdir(metadata, { recursive: true });
  await Deno.writeTextFile(join(metadata, "commondir"), "../..\n");
  await Deno.writeTextFile(
    join(metadata, "gitdir"),
    join(root, "linked", ".git") + "\n",
  );
  await Deno.writeTextFile(
    join(root, "linked", ".git"),
    `gitdir: ${metadata}\n`,
  );
  const module = join(root, "main", ".git", "modules", "module");
  await Deno.mkdir(module, { recursive: true });
  await Deno.writeTextFile(join(root, "module", ".git"), `gitdir: ${module}\n`);
  assertEquals(
    await scanProjects([join(root, "{project}")]),
    ["main", "module", "plain"].map((name) => join(root, name)),
  );
});

test("template source rescans on startup and edits, rejects retired results and cannot publish after close", async () => {
  const db = new OtkDb(await fixture(), [
    projectsMigrations,
    tasksMigrations,
    seenMigrations,
    finishesMigrations,
    projectTemplatesMigrations,
  ]);
  const templates = new ProjectTemplates(db);
  const reads: {
    templates: readonly string[];
    result: PromiseWithResolvers<string[]>;
  }[] = [];
  const feature = new InboxFeature(
    {
      projects: new Projects(db),
      tasks: new Tasks(db),
      seen: new Seen(db),
      finishes: new Finishes(db),
      templates,
    },
    new IndexStore(),
    "user",
    (paths) => {
      const result = Promise.withResolvers<string[]>();
      reads.push({ templates: paths, result });
      return result.promise;
    },
  );
  let frames = 0;
  feature.listen(() => frames++);
  try {
    assertEquals(reads[0].templates, ["~/Projects/{project}"]);
    templates.set(["/new/{project}"]);
    reads[1].result.resolve(["/new/one"]);
    await new Promise<void>((resolve) => queueMicrotask(resolve));
    assertEquals(feature.get().discovered, ["/new/one"]);
    reads[0].result.resolve(["/old/stale"]);
    await new Promise<void>((resolve) => queueMicrotask(resolve));
    assertEquals(feature.get().discovered, ["/new/one"]);
    templates.set(["/late/{project}"]);
    feature.close();
    const before = frames;
    reads[2].result.resolve(["/late/ignored"]);
    await new Promise<void>((resolve) => queueMicrotask(resolve));
    assertEquals(frames, before);
    assertEquals(feature.get().discovered, []);
  } finally {
    feature.close();
    db.close();
  }
});
