// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals } from "@std/assert";
import { DatabaseSync } from "node:sqlite";
import {
  projectSeeds,
  projectTopology,
  projectTopologyAt,
} from "../project-seeds.ts";

Deno.test("V1 topology uses native repo identity and longest registered checkout, never basenames", () => {
  const projects = [{
    id: "repo",
    worktree: "/repo",
    sandboxes: ["/trees/one", "/trees/one/nested"],
  }];
  assertEquals(projectTopology(projects, "repo", "/trees/one/nested/src"), {
    repoID: "repo",
    canonicalRoot: "/repo",
    leafDirectory: "/trees/one/nested",
    parentDirectory: "/repo",
  });
  assertEquals(projectTopology(projects, "global", "/trees/one"), undefined);
  assertEquals(projectTopology(projects, "other", "/trees/one"), undefined);
  assertEquals(
    projectTopology(projects, "repo", "/trees/one-extra"),
    undefined,
  );
  const db = new DatabaseSync(":memory:");
  assertEquals(projectTopologyAt(projects, "/trees/one")?.repoID, "repo");
  assertEquals(projectTopologyAt(projects, "/trees/one/src"), null);
  assertEquals(
    projectTopologyAt(
      [...projects, { id: "other", worktree: "/trees/one" }],
      "/trees/one",
    ),
    null,
  );
  try {
    db.exec(
      "CREATE TABLE session(project_id TEXT,directory TEXT,time_updated INTEGER); INSERT INTO session VALUES('repo','/trees/one',2),('repo','/trees/one',3)",
    );
    const [seed] = projectSeeds(db, "", 20, undefined, projects);
    assertEquals(seed.sessionCount, 2);
    assertEquals(seed.topology?.parentDirectory, "/repo");
  } finally {
    db.close();
  }
});

Deno.test("grouped V1 reads retain distinct native owners sharing a path", () => {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec(
      "CREATE TABLE session(project_id TEXT,directory TEXT,time_updated INTEGER); INSERT INTO session VALUES('one','/shared',1),('two','/shared',2)",
    );
    const [row] = projectSeeds(db, "", 10, undefined, [{
      id: "one",
      worktree: "/one",
      sandboxes: ["/shared"],
    }, { id: "two", worktree: "/two", sandboxes: ["/shared"] }]);
    assertEquals(row.sessionCount, 2);
    assertEquals(row.identities?.map((r) => r.repoID), ["one", "two"]);
    assertEquals(
      row.identities?.map((r) =>
        r.inventory?.find((i) => i.directory === "/shared")?.kind
      ),
      ["unknown", "unknown"],
    );
  } finally {
    db.close();
  }
});
