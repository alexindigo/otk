// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import { CheckoutRepositories, type ProjectSeed } from "@otk/harness";
import { entityKey, type IndexEntry } from "@otk/protocol";
import {
  Checkouts,
  checkoutsMigrations,
  Finishes,
  finishesMigrations,
  OtkDb,
  ProjectOrderStore,
  Projects,
  projectsMigrations,
  ProjectTemplates,
  projectTemplatesMigrations,
  requestsMigrations,
  Seen,
  seenMigrations,
  Tasks,
  tasksMigrations,
} from "@otk/store";
import { InboxFeature } from "../../core/features/inbox.ts";
import { ProjectOrder } from "../../core/features/project-order.ts";
import { ProjectIdentity } from "../../core/index/project-identity.ts";
import { IndexStore } from "../../core/index/store.ts";
import { tempDir, test } from "../support/resources.ts";

const user = "local";
const migrations = [
  projectsMigrations,
  tasksMigrations,
  seenMigrations,
  finishesMigrations,
  projectTemplatesMigrations,
  requestsMigrations,
];
const stores = (db: OtkDb) => ({
  checkouts: new Checkouts(db),
  projects: new Projects(db),
  tasks: new Tasks(db),
  seen: new Seen(db),
  finishes: new Finishes(db),
  templates: new ProjectTemplates(db),
});

test("D84 upgrade groups existing clones without resurfacing or losing user state", async () => {
  const base = await tempDir("remote-upgrade-");
  const paths = [
    "configqml",
    "interactive",
    "interactive.release",
    "configqml.view-refresh-clone",
    "atmosphera",
    "configqml.generic-clone",
  ].map((name) => join(base, name));
  const [main, plain, release, clone, after, removed] = paths;
  const git = async (cwd: string, ...args: string[]) => {
    const result = await new Deno.Command("git", {
      cwd,
      args,
      stdout: "null",
      stderr: "null",
    }).output();
    assertEquals(result.code, 0, args.join(" "));
  };
  for (const directory of [main, plain, release, clone, after]) {
    await git(base, "init", directory);
  }
  await git(
    main,
    "remote",
    "add",
    "origin",
    "git@github.com:AlexIndigo/configqml.git",
  );
  await git(
    clone,
    "remote",
    "add",
    "origin",
    "https://github.com/alexindigo/configqml",
  );
  await git(
    after,
    "remote",
    "add",
    "origin",
    "https://github.com/alexindigo/atmosphera.git",
  );
  await git(
    after,
    "remote",
    "add",
    "upstream",
    "https://github.com/noctalia-dev/atmosphera.git",
  );
  const repoID = (directory: string) =>
    directory === clone ? "configqml" : directory.slice(base.length + 1);
  const seed = (directory: string): ProjectSeed => ({
    directory,
    authority: "current",
    sessionCount: directory === clone ? 2 : directory === main ? 1 : 0,
    lastActivity: 100,
    presentation: {
      id: repoID(directory),
      name: directory === main || directory === clone
        ? "Config QML"
        : repoID(directory),
    },
    identities: [{
      source: "native",
      repoID: repoID(directory),
      recordedRoot: directory,
      canonicalRoot: directory === clone ? main : directory,
    }],
  });
  const discovery = await CheckoutRepositories.discover(paths);
  const seeds = await discovery.seeds(
    paths.map(seed),
    AbortSignal.timeout(10_000),
  );
  const open = (upgrade: boolean) =>
    new OtkDb(base, [
      ...migrations,
      upgrade ? checkoutsMigrations : {
        ...checkoutsMigrations,
        migrations: checkoutsMigrations.migrations.slice(0, 3),
      },
    ], { busyms: 0 });
  const before = open(false);
  const s = stores(before);
  const entries = [
    { id: "tstv1-main", directory: main, terminal: 100 },
    { id: "tstv1-seen", directory: clone, terminal: 101 },
    { id: "tstv1-unseen", directory: clone, terminal: 102 },
  ];
  const rows = async (db: OtkDb) =>
    await Promise.all([
      "tasks",
      "task_sessions",
      "session_seen",
      "session_run_seen",
      "session_finishes",
      "projects",
      "request_receipts",
    ].map(async (table) =>
      Array.from(
        new Uint8Array(
          await crypto.subtle.digest(
            "SHA-256",
            new TextEncoder().encode(
              JSON.stringify(
                db.connection.prepare(`SELECT * FROM ${table} ORDER BY rowid`)
                  .all(),
              ),
            ),
          ),
        ),
      )
    ));
  let expected: Awaited<ReturnType<typeof rows>>;
  let projects: ReturnType<ProjectOrderStore["list"]>;
  let task: ReturnType<Tasks["create"]>;
  try {
    // Retain an already-removed standalone clone with its former Git boundary.
    s.checkouts.save([{
      source: "native",
      repoID: repoID(removed),
      scope: removed,
      canonicalRoot: removed,
      leafDirectory: removed,
      kind: "checkout",
      availability: "removed",
      proven: true,
      repository: removed,
    }]);
    const identity = new ProjectIdentity({
      list: () => s.checkouts.list(),
      save: (records, authority) => s.checkouts.save(records, authority),
    });
    // Today's owners receive repository facts without the new evidence, and
    // write the old schema before the upgraded inbox is even constructed.
    identity.learn(
      seeds.map((value) => ({
        ...value,
        identities: value.identities!.map(({ repository, ...fact }) => {
          if (!repository) return fact;
          const { remote: _, ...previous } = repository;
          return { ...fact, repository: previous };
        }),
      })),
    );
    const orderStore = new ProjectOrderStore(before);
    const order = new ProjectOrder(orderStore, identity);
    for (const directory of paths) {
      s.projects.add(user, directory);
      order.admit(user, [directory]);
    }
    order.close();
    projects = orderStore.list(user);
    assertEquals(projects.map((p) => p.root), paths);
    task = s.tasks.create(
      clone,
      "Keep my task",
      entries.slice(1).map((e) => e.id),
    );
    for (const { id, terminal } of entries) s.finishes.observe(id, terminal);
    for (const { id, terminal } of entries.slice(0, 2)) {
      s.seen.acknowledge(user, id, terminal);
      before.connection.prepare("INSERT INTO session_run_seen VALUES(?,?,?,?)")
        .run(user, id, `run-${terminal}`, terminal);
    }
    s.projects.inactive(user, clone, true);
    expected = await rows(before);
  } finally {
    before.close();
  }

  for (const restart of [false, true]) {
    const db = open(true);
    const index = new IndexStore();
    const inbox = new InboxFeature(
      stores(db),
      index,
      user,
      () => Promise.resolve([]),
    );
    try {
      index.projectSeeds(seeds);
      for (const { id, directory, terminal } of entries) {
        const entry: IndexEntry = {
          id,
          directory,
          checkoutRoot: directory,
          projectID: repoID(directory),
          title: id,
          timeCreated: 1,
          timeUpdated: terminal,
          status: "idle",
          archived: false,
          digest: { state: "digesting", revision: 0, turns: {} },
          attention: {
            permissions: 0,
            questions: 0,
            childPermissions: 0,
            childQuestions: 0,
          },
          activity: { terminal },
        };
        index.upsert(entry);
      }
      assertEquals(
        inbox.projectOrder.frame(user).projects,
        projects.filter((p) => p.root !== clone).map(({ id, directories }) => ({
          id,
          directories: directories[0] === main ? [main, clone] : directories,
        })),
        `rank and aliases across restart=${restart}`,
      );
      const snapshot = inbox.get();
      assertEquals(
        snapshot.summaries?.[main]?.presentation?.name,
        "Config QML",
      );
      assertEquals(
        snapshot.summaries?.[clone]?.topology?.parentDirectory,
        main,
      );
      assertEquals(
        snapshot.summaries?.[removed]?.topology?.canonicalRoot,
        removed,
      );
      assertEquals(
        snapshot.summaries?.[release]?.topology?.canonicalRoot,
        release,
      );
      assertEquals(
        inbox.get({ directory: clone, epoch: 0, crumbs: [], rows: [] }).tasks,
        [task],
      );
      assertEquals(
        inbox.states.get(entityKey("session", "tstv1-seen"))?.state,
        "none",
      );
      assertEquals(
        inbox.states.get(entityKey("session", "tstv1-unseen"))?.state,
        "finished",
      );
      assertEquals(
        inbox.states.get(entityKey("project", main))?.state,
        "finished",
      );
      assertEquals(
        snapshot.projects.find((project) => project.directory === clone)
          ?.inactive,
        true,
      );
      assertEquals(await rows(db), expected);
      assert(
        db.connection.prepare(
          "SELECT 1 FROM otk_migrations WHERE feature='checkouts' AND version=4",
        ).get(),
      );
    } finally {
      inbox.close();
      db.close();
    }
  }
});
