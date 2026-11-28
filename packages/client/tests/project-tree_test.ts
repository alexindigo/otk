// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals } from "@std/assert";
import { projectTree, projectTreeKey } from "../project-tree.ts";
import type { ProjectProjectionRow } from "../project-projection.ts";
import { treePaths } from "../tree-paths.ts";

const row = (directory: string, parent?: string, sidecarId = "local") => ({
  directory,
  sidecarId,
  status: "none",
  topology: {
    ...(parent ? { parentDirectory: parent } : {}),
    canonicalRoot: parent ?? directory,
    repoID: "repository",
  },
} as ProjectProjectionRow & { sidecarId: string });

Deno.test("project tree preserves topology and server identity independently of status", () => {
  const root = row("/repo"), child = row("/tree", "/repo");
  child.status = "working";
  const foreign = row("/tree", "/repo", "other");
  const tree = projectTree([root, child, foreign]);
  assertEquals(tree.map((node) => node.project.directory), ["/repo", "/tree"]);
  assertEquals(tree[0].children[0].key, projectTreeKey(child));
  assertEquals(tree[0].children[0].project.status, "working");
  assertEquals(tree[1].children, []);
});
Deno.test("missing and cyclic project parents never hide projects", () => {
  const a = row("/a", "/b"), b = row("/b", "/a");
  a.topology!.canonicalRoot = b.topology!.canonicalRoot = "/repo";
  const tree = projectTree([
    a,
    b,
    row("/c", "/missing"),
  ]);
  assertEquals(tree.length, 3);
  assertEquals(tree.every((node) => node.children.length === 0), true);
});
Deno.test("project branches require the same proven repository, not only a matching parent path", () => {
  const root = row("/repo"), child = row("/tree", "/repo");
  child.topology = { ...child.topology!, repoID: "other" };
  assertEquals(projectTree([root, child]).length, 2);
  child.topology = {
    ...child.topology,
    repoID: "repository",
    canonicalRoot: "/different",
  };
  assertEquals(projectTree([root, child]).length, 2);
});
Deno.test("D84 uses the published group, not a clone's native repository ID", () => {
  const root = row("/repo"), clone = row("/clone", "/repo");
  root.topology!.group = clone.topology!.group = "github.com/example/repo";
  clone.topology!.repoID = "different-native-id";
  assertEquals(projectTree([root, clone]).map((p) => p.children.length), [1]);
  clone.topology!.group = "github.com/example/other";
  clone.topology!.repoID = root.topology!.repoID;
  assertEquals(projectTree([root, clone]).map((p) => p.children.length), [
    0,
    0,
  ]);
});
Deno.test("virtual tree paths stop at the last sibling, retaining ancestor continuations", () => {
  assertEquals(treePaths([0, 1, 2, 2, 1, 0], (value) => value), [
    [],
    [true],
    [true, true],
    [true, false],
    [false],
    [],
  ]);
});
