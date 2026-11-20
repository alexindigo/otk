// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals, assertStrictEquals } from "@std/assert";
import { createProjectDisclosure } from "../project-disclosure.ts";
import { projectHierarchy } from "../inbox.ts";
import { projectBranchPresentation, projectTree } from "../project-tree.ts";

Deno.test("project disclosure paints before persistence, orders opposing saves and retries the latest intent", async () => {
  const requests: {
    open: boolean;
    resolve(): void;
    reject(e: unknown): void;
  }[] = [];
  const retried = Promise.withResolvers<void>();
  let persisted = true;
  const owner = createProjectDisclosure();
  const target = { sidecarId: "one", directory: "/repo" };
  const branch = owner.bind(
    "project",
    target,
    () => persisted,
    (open) =>
      new Promise<void>((resolve, reject) => {
        requests.push({ open, resolve, reject });
        if (requests.length === 3) retried.resolve();
      }),
  );
  const first = branch.set(false);
  assertEquals(branch.open(), false);
  assertEquals(branch.pending(), true);
  const second = branch.set(true);
  assertEquals(branch.open(), true);
  assertEquals(requests.map((r) => r.open), [false]);
  persisted = false;
  requests[0].resolve();
  await first;
  await Promise.resolve();
  assertEquals(branch.open(), true);
  assertEquals(requests.map((r) => r.open), [false, true]);
  requests[1].reject(new Error("save refused"));
  await second;
  assertEquals(branch.open(), true);
  assertEquals(branch.pending(), false);
  assertEquals(branch.error() instanceof Error, true);
  const retry = branch.retry();
  assertEquals(branch.pending(), true);
  await retried.promise;
  assertEquals(requests[2].open, true);
  persisted = true;
  requests[2].resolve();
  await retry;
  assertEquals(branch.error(), undefined);
  assertEquals(owner.bind("project", target, () => persisted).open(), true);
  assertEquals(
    createProjectDisclosure().bind("project", target, () => persisted).open(),
    true,
  );
});

Deno.test("every section shares disclosure identity without aliasing servers or row kinds", async () => {
  const owner = createProjectDisclosure();
  const target = { sidecarId: "one", directory: "/repo" };
  for (
    const kind of ["project", "archive", "discovered", "inactive"] as const
  ) {
    const branch = owner.bind(kind, target, () => false);
    await branch.set(true);
    assertEquals(owner.bind(kind, target, () => false).open(), true);
    assertEquals(
      owner.bind(kind, { ...target, sidecarId: "two" }, () => false).open(),
      false,
    );
  }
});

function row(
  directory: string,
  status: "none" | "working" = "none",
  root = "/repo",
) {
  return {
    directory,
    sidecarId: "one",
    status,
    added: true,
    inactive: false,
    order: 0,
    lastVisit: 0,
    unread: false,
    visitText: "now",
    ageing: 0,
    topology: {
      repoID: "repo",
      canonicalRoot: root,
      leafDirectory: directory,
      ...(directory !== root ? { parentDirectory: root } : {}),
    },
  };
}
Deno.test("row artwork is topology-owned across missing roots, section filtering and topology changes", () => {
  const native = {
    presentation: { id: "repo", name: "Native repository", color: "#628cba" },
  };
  const rows = projectHierarchy([{ ...row("/repo"), summary: native }, {
    ...row("/worktree"),
    summary: native,
  }]);
  assertEquals(rows.map((r) => [r.level, r.artwork]), [["project", "avatar"], [
    "worktree",
    "none",
  ]]);
  assertEquals(projectHierarchy([row("/worktree")])[0].artwork, "none");
  assertEquals(rows.map((r) => r.displayName), [
    "Native repository",
    "worktree",
  ]);
  assertEquals(
    projectHierarchy([row("/worktree", "none", "/worktree")])[0].artwork,
    "avatar",
  );
});

Deno.test("hierarchy artwork preserves unchanged owner row identity while topology updates replace presentation", () => {
  const root = row("/repo"), child = row("/child");
  const first = projectHierarchy([root, child]);
  const second = projectHierarchy([root, child]);
  assertStrictEquals(second[0], first[0]);
  assertStrictEquals(second[1], first[1]);
  const changed = projectHierarchy([root, {
    ...child,
    topology: {
      ...child.topology,
      canonicalRoot: "/child",
      parentDirectory: undefined,
    },
  }]);
  assertStrictEquals(changed[0], first[0]);
  assertEquals(changed[1].level, "project");
});
Deno.test("branch presentation handles empty, all-required, archive-only, mixed and large branches", () => {
  for (const count of [0, 1, 2, 200]) {
    const tree = projectTree([
      row("/repo"),
      ...Array.from(
        { length: count },
        (_, n) => row(`/worktree-${n}`, "working"),
      ),
    ])[0];
    const view = projectBranchPresentation(tree, false, {
      count: 0,
      status: "none",
    });
    assertEquals(view.children.length, count);
    assertEquals(view.protectedCount, count);
    assertEquals(view.hasChildren, count > 0);
  }
  const tree =
    projectTree([row("/repo"), row("/quiet"), row("/busy", "working")])[0];
  assertEquals(
    projectBranchPresentation(tree, false, { count: 1, status: "none" })
      .children.map((c) => c.project.directory),
    ["/busy"],
  );
  const empty = projectTree([row("/repo")])[0];
  assertEquals(
    projectBranchPresentation(empty, false, {
      count: 3,
      status: "finished",
      requiredCount: 1,
    }).protectedCount,
    1,
  );
  assertEquals(
    projectBranchPresentation(empty, false, { count: 1, status: "none" })
      .archiveVisible,
    false,
  );
  assertEquals(
    projectBranchPresentation(empty, true, { count: 1, status: "none" })
      .archiveVisible,
    true,
  );
  assertEquals(
    projectBranchPresentation(empty, false, { count: 1, status: "finished" })
      .archiveVisible,
    true,
  );
});
