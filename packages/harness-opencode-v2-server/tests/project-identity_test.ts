// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals, assertThrows } from "@std/assert";
import { ProjectIdentity } from "../../../core/index/project-identity.ts";
import type { ProjectSeed } from "@otk/harness";
import { Checkouts, checkoutsMigrations, OtkDb } from "@otk/store";
import { recordedCheckout, V2ProjectTopology } from "../project-topology.ts";
import { V2NativeDb } from "../native-db.ts";
import { DatabaseSync } from "node:sqlite";

const seed = (
  directory: string,
  root: string | null,
  inventory?: string[],
): ProjectSeed => ({
  directory,
  hasSessions: true,
  sessionCount: 1,
  lastActivity: 1,
  authority: "current",
  identities: [{
    source: "fixture",
    repoID: "repo",
    canonicalRoot: "/repo",
    recordedRoot: root,
    inventory: inventory?.map((directory) => ({
      directory,
      kind: "worktree" as const,
    })),
  }],
});

// INV-O required contracts now exercise the durable owner, not stateless helpers.
Deno.test("historical membership survives pruning on warm and cold imports", () => {
  const owner = new ProjectIdentity();
  owner.learn([seed("/tree/src", "/tree", ["/repo", "/tree"])]);
  owner.learn([seed("/tree/src", null, ["/repo"])]);
  assertEquals(owner.topology("/tree")?.parentDirectory, "/repo");
  assertEquals(owner.availability("/tree"), "removed");
  assertEquals(owner.leaf("/tree/src", "repo"), "/tree");
  const cold = new ProjectIdentity();
  cold.learn([seed("/tree/src", "/tree", ["/repo"])]);
  assertEquals(cold.topology("/tree")?.parentDirectory, "/repo");
  assertEquals(cold.availability("/tree"), "removed");
});

Deno.test("unavailable inventory changes availability, never membership", () => {
  const owner = new ProjectIdentity();
  owner.learn([seed("/tree/src", "/tree", ["/tree"])]);
  owner.learn([seed("/tree/src", null)]);
  assertEquals(owner.leaf("/tree/src", "repo"), "/tree");
  assertEquals(owner.availability("/tree"), "unknown");
});

Deno.test("unknown checkout boundaries stay under the proven repo without inventing worktrees", () => {
  const owner = new ProjectIdentity();
  owner.learn([seed("/gone/src", null, ["/repo"])]);
  assertEquals(owner.topology("/gone/src")?.parentDirectory, "/repo");
  assertEquals(owner.availability("/gone/src"), "unknown");
  assertEquals(owner.records()[0].kind, "unknown");
});

Deno.test("a missing native project row retains positive session ownership without fabricating a parent", () => {
  const owner = new ProjectIdentity();
  owner.learn([{
    ...seed("/lost/src", "/lost"),
    identities: [{
      source: "fixture",
      repoID: "missing",
      recordedRoot: "/lost",
    }],
  }]);
  assertEquals(owner.records()[0].repoID, "missing");
  assertEquals(owner.leaf("/lost/src", "missing"), "/lost");
  assertEquals(owner.topology("/lost"), undefined);
  assertEquals(owner.availability("/lost"), "unknown");
});

Deno.test("distinct native owners and sources retain their own scopes at a reused path", () => {
  const owner = new ProjectIdentity();
  const first = seed("/tree/src", "/tree", ["/tree"]);
  const second = {
    ...first,
    identities: [{
      ...first.identities![0],
      repoID: "other",
      canonicalRoot: "/other",
    }],
  };
  owner.learn([first, second]);
  assertEquals(owner.records().length, 2);
  assertEquals(owner.topology("/tree"), undefined);
  assertEquals(owner.leaf("/tree/src", "repo"), "/tree");
  assertEquals(owner.leaf("/tree/src", "other"), "/tree");
  owner.learn([{
    ...first,
    identities: [{
      ...first.identities![0],
      source: "replacement",
      recordedRoot: null,
      inventory: [],
    }],
  }]);
  assertEquals(owner.records().length, 3);
  assertEquals(owner.leaf("/tree/src", "repo"), "/tree/src");
});

Deno.test("recorded NULL, empty and nested paths remain distinct and traversal is never guessed", () => {
  assertEquals(recordedCheckout("/tree/src", null), undefined);
  assertEquals(recordedCheckout("/tree/src", ""), "/tree/src");
  assertEquals(recordedCheckout("/tree/src", "src"), "/tree");
  for (const invalid of ["../src", "/src", "src/..", "different", "src//lib"]) {
    assertEquals(recordedCheckout("/tree/src", invalid), undefined);
  }
  const owner = new ProjectIdentity();
  owner.learn([seed("/repo/removed/src", null, ["/repo"])]);
  assertEquals(owner.leaf("/repo/removed/src", "repo"), "/repo/removed/src");
  assertEquals(owner.availability("/repo/removed/src"), "unknown");
});

Deno.test("checkout history survives store reopen and canonical relocation without changing source scopes", () => {
  const directory = Deno.makeTempDirSync({ prefix: "checkout-history-" });
  try {
    let db = new OtkDb(directory, [checkoutsMigrations], { busyms: 0 });
    new ProjectIdentity(new Checkouts(db)).learn([
      seed("/tree/src", "/tree", ["/repo", "/tree"]),
    ]);
    db.close();
    db = new OtkDb(directory, [checkoutsMigrations], { busyms: 0 });
    try {
      const owner = new ProjectIdentity(new Checkouts(db));
      assertEquals(owner.leaf("/tree/src", "repo"), "/tree");
      assertEquals(owner.availability("/tree"), "unknown");
      const moved = seed("/tree/src", null, ["/relocated"]);
      moved.identities = [{
        ...moved.identities![0],
        canonicalRoot: "/relocated",
      }];
      owner.learn([moved]);
      assertEquals(owner.leaf("/tree/src", "repo"), "/tree");
      assertEquals(owner.topology("/tree")?.parentDirectory, "/relocated");
      assertEquals(owner.availability("/tree"), "removed");
      assertEquals(new Checkouts(db).list()[0].scope, "/tree/src");
    } finally {
      db.close();
    }
  } finally {
    Deno.removeSync(directory, { recursive: true });
  }
});

Deno.test("grouped V2 reads preserve every native owner and NULL versus empty recorded path", () => {
  const root = Deno.makeTempDirSync({ prefix: "checkout-owners-" });
  const file = root + "/native.db", writer = new DatabaseSync(file);
  try {
    writer.exec(
      "CREATE TABLE project(id TEXT,worktree TEXT); CREATE TABLE session_v2(id TEXT,project_id TEXT,directory TEXT,path TEXT,parent_id TEXT,time_created INTEGER,time_updated INTEGER); INSERT INTO session_v2 VALUES('a','one','/shared',NULL,NULL,1,2),('b','one','/shared','',NULL,1,2),('c','two','/shared','src',NULL,1,2)",
    );
    const db = new V2NativeDb(file);
    try {
      const [row] = db.projects("", 10);
      assertEquals(row.sessionCount, 3);
      assertEquals(row.owners, [{ projectID: "one", path: null }, {
        projectID: "one",
        path: "",
      }, { projectID: "two", path: "src" }]);
    } finally {
      db.close();
    }
  } finally {
    writer.close();
    Deno.removeSync(root, { recursive: true });
  }
});

Deno.test("independent clones retain checkout kind instead of being invented Git worktrees", () => {
  const topology = new V2ProjectTopology([{
    id: "repo",
    canonical: "/repo",
    worktrees: [
      { directory: "/repo" },
      { directory: "/clone" },
      { directory: "/linked", strategy: "git" },
    ],
  }]);
  const owner = new ProjectIdentity();
  owner.learn(["/clone", "/linked"].map((directory) => ({
    ...seed(directory, directory),
    identities: topology.facts(directory, "repo", "fixture", ""),
  })));
  assertEquals(owner.records().map((r) => [r.leafDirectory, r.kind]), [[
    "/clone",
    "checkout",
  ], ["/linked", "worktree"]]);
});

Deno.test("failed history writes cannot advance identity or suppress a later retry", () => {
  let fail = true, writes = 0;
  const owner = new ProjectIdentity({
    list: () => [],
    save: () => {
      writes++;
      if (fail) throw new Error("history unavailable");
    },
  });
  const facts = seed("/tree/src", "/tree", ["/tree"]);
  assertThrows(() => owner.learn([facts]), Error, "history unavailable");
  assertEquals(owner.records(), []);
  fail = false;
  owner.learn([facts]);
  assertEquals(writes, 2);
  assertEquals(owner.leaf("/tree/src", "repo"), "/tree");
  fail = true;
  assertThrows(
    () => owner.remember("/tree/lib", "repo", "/tree"),
    Error,
    "history unavailable",
  );
  assertEquals(owner.records().some((r) => r.scope === "/tree/lib"), false);
});

Deno.test("positive native ownership revisions select current scope ownership without deleting history", () => {
  const owner = new ProjectIdentity();
  const first = seed("/tree/src/lib", "/tree", ["/tree"]);
  owner.learn([first]);
  owner.learn([{
    ...first,
    identities: [{
      ...first.identities![0],
      repoID: "new-repo",
      canonicalRoot: "/new",
      recordedRoot: "/tree/src",
      inventory: [{ directory: "/tree/src", kind: "checkout" }],
    }],
  }]);
  assertEquals(owner.leaf("/tree/src/lib"), "/tree/src");
  assertEquals(
    owner.records().some((r) =>
      r.repoID === "repo" && r.leafDirectory === "/tree"
    ),
    true,
  );
  assertEquals(owner.memberships("/tree").length, 0);
  assertEquals(owner.memberships("/tree/src")[0].repoID, "new-repo");
});
