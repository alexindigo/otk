// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals } from "@std/assert";
import { V2ProjectTopology } from "../project-topology.ts";

Deno.test("V2 topology chooses the longest checkout only inside the native project", () => {
  const topology = new V2ProjectTopology([
    {
      id: "repo",
      canonical: "/repo",
      worktrees: [{ directory: "/repo/trees/a" }, { directory: "/elsewhere" }],
    },
    { id: "other", canonical: "/repo/trees/a/nested", worktrees: [] },
  ]);
  assertEquals(topology.resolve("/repo/trees/a/nested/src", "repo"), {
    repoID: "repo",
    canonicalRoot: "/repo",
    leafDirectory: "/repo/trees/a",
    parentDirectory: "/repo",
  });
  assertEquals(topology.resolve("/repo/trees/a/nested/src", "other"), {
    repoID: "other",
    canonicalRoot: "/repo/trees/a/nested",
    leafDirectory: "/repo/trees/a/nested",
  });
  assertEquals(
    topology.resolve("/repo/trees/ab", "repo")?.leafDirectory,
    "/repo",
  );
  assertEquals(topology.resolve("/repo-other", "repo"), null);
  assertEquals(
    topology.resolve("/elsewhere/src", "repo")?.leafDirectory,
    "/elsewhere",
  );
  assertEquals(topology.resolve("/repo"), null);
  assertEquals(topology.resolve("/repo", "missing"), null);
  assertEquals(topology.root("/repo/src"), null);
});

Deno.test("V2 topology distinguishes failed inventory and ambiguous roots without retiring native affiliation", () => {
  const failed = new V2ProjectTopology([{ id: "repo", canonical: "/repo" }]);
  assertEquals(failed.resolve("/repo/src", "repo"), undefined);
  assertEquals(failed.root("/repo"), undefined);
  const ambiguous = new V2ProjectTopology([
    { id: "repo", canonical: "/repo", worktrees: [{ directory: "/shared" }] },
    { id: "other", canonical: "/shared", worktrees: [] },
  ]);
  assertEquals(ambiguous.root("/shared"), null);
  const retired = new V2ProjectTopology([{
    id: "repo",
    canonical: "/repo",
    worktrees: [],
  }]);
  assertEquals(retired.facts("/elsewhere/src", "repo", "fixture", "src"), [{
    source: "fixture",
    repoID: "repo",
    canonicalRoot: "/repo",
    recordedRoot: "/elsewhere",
    inventory: [],
  }]);
  assertEquals(retired.root("/elsewhere"), null);
});
