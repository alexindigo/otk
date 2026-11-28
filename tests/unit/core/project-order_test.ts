// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals } from "@std/assert";
import {
  Checkouts,
  checkoutsMigrations,
  OtkDb,
  ProjectOrderStore,
  projectsMigrations,
} from "@otk/store";
import type { ProjectSeed } from "@otk/harness";
import { ProjectIdentity } from "../../../core/index/project-identity.ts";
import { ProjectOrder } from "../../../core/features/project-order.ts";
import { tempDir, test } from "../../support/resources.ts";

test("D84 upgrade preserves rank and alias order, then reroots and splits directly after the old slot", async () => {
  const db = new OtkDb(await tempDir("grouped-order-"), [
    projectsMigrations,
    checkoutsMigrations,
  ], { busyms: 0 });
  const history = new Checkouts(db);
  const store = new ProjectOrderStore(db);
  const identity = new ProjectIdentity(history);
  const order = new ProjectOrder(store, identity);
  const main = "/main",
    clone = "/clone",
    first = "/clone.z",
    second = "/clone.a";
  const key = "github.com/org/repo";
  const fact = (
    directory: string,
    root = directory,
    remote?: string,
    present = true,
  ): ProjectSeed => ({
    directory,
    authority: "current",
    sessionCount: 1,
    lastActivity: 1,
    identities: [{
      source: "native",
      repoID: root,
      canonicalRoot: main,
      recordedRoot: directory,
      repository: {
        checkout: directory,
        root: present ? root : null,
        present,
        evidence: present ? "git" : "none",
        ...(remote === undefined ? {} : { remote: { key: remote } }),
      },
    }],
  });
  const learn = (...seeds: ProjectSeed[]) =>
    order.admit("u", [], identity.learn(seeds).directories);
  const roots = () => store.list("u").map((p) => p.root);
  try {
    for (const path of ["/start", main, "/middle", clone, "/end"]) {
      order.admit("u", [path]);
    }
    const primaryID = store.alias("u", main);
    const cloneID = store.alias("u", clone);
    learn(fact(main), fact(clone), fact(first, clone), fact(second, clone));
    order.admit("u", [first]);
    order.admit("u", [second]);
    const changes: unknown[] = [];
    const off = store.listen((change) => changes.push(change));
    // Simulate interruption after identity persisted, before order receives its revisions.
    identity.learn([fact(main, main, key), fact(clone, clone, key)]);
    const restart = new ProjectOrder(store, new ProjectIdentity(history));
    restart.admit("u", []);
    restart.close();
    assertEquals(roots(), ["/start", main, "/middle", "/end"]);
    assertEquals(changes, [{ user: "u", removed: [cloneID] }]);
    assertEquals(store.list("u")[1].directories, [main, clone, first, second]);
    off();

    learn(fact(main, main, undefined, false));
    assertEquals(roots(), ["/start", clone, "/middle", "/end"]);
    assertEquals(store.alias("u", clone), primaryID);
    assertEquals(store.list("u")[1].directories, [clone, main, first, second]);
    learn(fact(main, main, "github.com/org/other"));
    assertEquals(roots(), ["/start", clone, main, "/middle", "/end"]);
    assertEquals(store.list("u")[1].directories, [clone, first, second]);
    assertEquals(store.alias("u", clone), primaryID);
    assertEquals(
      db.connection.prepare(
        "SELECT rank FROM project_order WHERE user='u' ORDER BY rank",
      ).all().map((r) => r.rank),
      [0, 1, 2, 3, 4],
    );
  } finally {
    order.close();
    db.close();
  }
});

test("project order preserves proven checkout continuity without conflating clones", async () => {
  const path = await tempDir("project-order-");
  const db = new OtkDb(path, [projectsMigrations], { busyms: 5000 });
  try {
    const topology = new Map<
      string,
      NonNullable<ReturnType<ProjectIdentity["topology"]>>
    >();
    const membership = new Map<
      string,
      ReturnType<ProjectIdentity["memberships"]>
    >();
    const identity = {
      topology: (directory: string) => topology.get(directory),
      memberships: (directory: string) => membership.get(directory) ?? [],
    };
    const evidence = (
      directory: string,
      root = directory,
      inventory: "current" | "unknown" = "current",
      availability: "present" | "removed" | "unknown" = "present",
    ) => {
      topology.set(directory, {
        repoID: "repo",
        leafDirectory: directory,
        canonicalRoot: root,
      });
      membership.set(directory, [{
        directory,
        source: "native",
        repoID: "repo",
        leafDirectory: directory,
        kind: "checkout",
        inventory,
        availability,
      }]);
    };
    const store = new ProjectOrderStore(db);
    db.connection.exec(
      "INSERT INTO project_order_legacy VALUES ('u','/a',0),('u','/otk',1),('u','/z',2),('v','/b',0),('v','/a',1)",
    );
    const order = new ProjectOrder(store, identity);
    const frames: number[] = [];
    order.listen(() => frames.push(order.revision));
    const roots = () =>
      order.frame("u").projects.map((row) => row.directories[0]);
    evidence("/otk");
    order.admit("u", ["/z", "/otk", "/a"]);
    assertEquals(roots(), ["/a", "/otk", "/z"]);
    assertEquals(frames, [2]);
    assertEquals(store.legacy("u"), []);
    order.admit("v", ["/d", "/c"]);
    assertEquals(order.frame("v").projects.map((row) => row.directories[0]), [
      "/b",
      "/a",
      "/c",
      "/d",
    ]);
    const otk = store.alias("u", "/otk");
    evidence("/clone");
    order.admit("u", ["/clone"]);
    evidence("/otk", "/otk", "unknown", "removed");
    evidence("/future-clone");
    order.admit("u", ["/future-clone"]);
    evidence("/otk", "/otk", "current", "removed");
    evidence("/new/otk");
    order.admit("u", ["/new/otk"]);
    assertEquals(roots(), ["/a", "/new/otk", "/z", "/clone", "/future-clone"]);
    assertEquals(store.alias("u", "/new/otk"), otk);
    const dirs = () => order.frame("u").projects[1].directories;
    evidence("/worktree", "/new/otk");
    order.admit("u", ["/worktree", "/late-worktree"]);
    assertEquals(dirs(), ["/new/otk", "/otk", "/worktree"]);
    evidence("/late-worktree", "/new/otk");
    order.admit("u", [], ["/late-worktree"]);
    topology.delete("/late-worktree");
    order.admit("u", [], ["/late-worktree"]);
    assertEquals(dirs(), ["/new/otk", "/otk", "/worktree", "/late-worktree"]);
    assertEquals(roots(), ["/a", "/new/otk", "/z", "/clone", "/future-clone"]);
    const cold = new ProjectOrder(store, {
      topology: () => undefined,
      memberships: () => [],
    });
    cold.admit("u", ["/new/otk", "/otk"]);
    assertEquals(cold.frame("u").projects, order.frame("u").projects);
    cold.close();
    order.close();
  } finally {
    db.close();
    await Deno.remove(path, { recursive: true });
  }
});
