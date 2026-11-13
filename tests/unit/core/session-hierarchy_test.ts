// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals } from "@std/assert";
import { SessionHierarchy } from "../../../core/index/session-hierarchy.ts";
import { ProjectIdentity } from "../../../core/index/project-identity.ts";
import type { TaskRecord } from "@otk/protocol";

Deno.test("hierarchy separates global families, local anchors and nearest task ownership", () => {
  const owner = new SessionHierarchy(), identity = new ProjectIdentity();
  const tasks: TaskRecord[] = [{
    id: "task",
    name: "Parent task",
    directory: "/repo",
    order: 0,
    sessions: ["root"],
  }];
  owner.configure(identity, () => tasks, (id) => id === "leaf");
  owner.reset([
    { id: "root", directory: "/repo" },
    { id: "child", directory: "/tree", parentID: "root" },
    { id: "leaf", directory: "/tree", parentID: "child" },
  ]);
  assertEquals(owner.node("leaf"), {
    familyID: "root",
    rootID: "root",
    ancestry: "complete",
    anchorID: "child",
    projectDirectory: "/tree",
    mandatory: true,
    followParent: false,
  });
  assertEquals(owner.node("leaf", true)?.taskID, "task");
  tasks.push({
    ...tasks[0],
    id: "near",
    directory: "/tree",
    sessions: ["child"],
  });
  owner.invalidate();
  assertEquals(owner.node("leaf")?.taskID, "near");
  assertEquals(owner.node("leaf", true)?.taskID, "near");
  assertEquals(owner.owner("leaf", new Set(["root"])), "root");
  assertEquals(owner.ancestors("leaf"), ["child", "root"]);
});

Deno.test("missing, late, deleted and cyclic ancestry never removes a mandatory node", async () => {
  const owner = new SessionHierarchy();
  owner.configure(new ProjectIdentity(), () => [], () => true);
  const child = { id: "child", directory: "/tree", parentID: "parent" };
  owner.entry(child);
  assertEquals(owner.node("child")?.ancestry, "unresolved");
  assertEquals(owner.node("child")?.anchorID, "child");
  const reads: string[][] = [];
  await owner.prepare([child], (ids) => {
    reads.push([...ids]);
    return Promise.resolve([{ id: "parent", directory: "/repo" }]);
  });
  assertEquals(reads, [["parent"]]);
  assertEquals(owner.node("child")?.rootID, "parent");
  owner.remove("parent");
  assertEquals(owner.node("child")?.mandatory, true);
  assertEquals(owner.node("child")?.ancestry, "unresolved");
  owner.entry({ id: "parent", directory: "/tree", parentID: "child" });
  assertEquals(owner.node("child")?.ancestry, "cyclic");
  assertEquals(owner.node("child")?.familyID, owner.node("parent")?.familyID);
  assertEquals(owner.node("child")?.anchorID, "child");
});

Deno.test("hierarchy uses PH1 checkout membership without changing exact locations", () => {
  const owner = new SessionHierarchy(), identity = new ProjectIdentity();
  identity.learn([{
    directory: "/tree/src",
    sessionCount: 1,
    lastActivity: 1,
    authority: "current",
    topology: {
      repoID: "p",
      canonicalRoot: "/repo",
      leafDirectory: "/tree",
      parentDirectory: "/repo",
    },
  }]);
  const tasks: TaskRecord[] = [{
    id: "local",
    name: "Local",
    directory: "/tree",
    sessions: ["root"],
    order: 0,
  }];
  owner.configure(identity, () => tasks, () => false);
  owner.reset([
    { id: "root", directory: "/tree", projectID: "p" },
    { id: "child", directory: "/tree/src", projectID: "p", parentID: "root" },
  ]);
  assertEquals(owner.node("child")?.projectDirectory, "/tree");
  assertEquals(owner.node("child")?.taskID, "local");
  assertEquals(owner.node("child")?.anchorID, "root");
});

Deno.test("a keyed move cannot retain a repository identity from the old directory", () => {
  const owner = new SessionHierarchy(), identity = new ProjectIdentity();
  identity.learn([{
    directory: "/repo",
    sessionCount: 1,
    lastActivity: 1,
    authority: "current",
    topology: { repoID: "old", canonicalRoot: "/repo", leafDirectory: "/repo" },
  }]);
  owner.configure(identity, () => [], () => false);
  owner.entry({ id: "root", directory: "/repo", projectID: "old" });
  owner.entry({
    id: "child",
    directory: "/repo",
    projectID: "old",
    parentID: "root",
  });
  // The narrow identities port intentionally has no native project ID. A move
  // must retire that directory's old identity until fresh metadata supplies it.
  owner.entry({
    id: "child",
    directory: "/repo/nested-new-repo",
    parentID: "root",
  });
  assertEquals(owner.node("child")?.projectDirectory, "/repo/nested-new-repo");
  assertEquals(owner.node("child")?.rootID, "root");
  assertEquals(owner.node("child")?.anchorID, "child");
});
