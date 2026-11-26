// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals } from "@std/assert";
import { OtkDb, ProjectOrderStore, projectsMigrations } from "@otk/store";
import type { ProjectIdentity } from "../../../core/index/project-identity.ts";
import { ProjectOrder } from "../../../core/features/project-order.ts";
import { tempDir, test } from "../../support/resources.ts";

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
