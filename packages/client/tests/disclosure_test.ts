// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals, assertStrictEquals, assertThrows } from "@std/assert";
import { createDisclosures, DISCLOSURE_KINDS } from "../disclosure.ts";
import { projectHierarchy } from "../inbox.ts";
import { projectBranchPresentation, projectTree } from "../project-tree.ts";

const repo = { scope: "one", id: "/repo" };

Deno.test("project disclosure paints before persistence, orders opposing saves and retries the latest intent", async () => {
  const requests: {
    open: boolean;
    resolve(): void;
    reject(e: unknown): void;
  }[] = [];
  const retried = Promise.withResolvers<void>();
  let persisted = true;
  const store = {
    read: () => persisted,
    save: (_: typeof repo, open: boolean) =>
      new Promise<void>((resolve, reject) => {
        requests.push({ open, resolve, reject });
        if (requests.length === 3) retried.resolve();
      }),
  };
  const durable = { projectBranch: store };
  const owner = createDisclosures({ durable });
  const branch = owner.bind("projectBranch", repo);
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
  assertEquals(owner.bind("projectBranch", repo).open(), true);
  assertEquals(
    createDisclosures({ durable }).bind("projectBranch", repo).open(),
    true,
  );
});

Deno.test("a late refusal leaves the newest choice pending until its save and baseline catch up", async () => {
  const first = Promise.withResolvers<void>();
  const second = Promise.withResolvers<void>();
  let saved = true;
  const owner = createDisclosures({
    durable: {
      projectBranch: {
        read: () => saved,
        save: (_, open) => open ? first.promise : second.promise,
      },
    },
  });
  const branch = owner.bind("projectBranch", repo);
  const earlier = branch.set(true);
  const later = branch.set(false);
  first.reject(new Error("old save refused"));
  await earlier;
  assertEquals(branch.error(), undefined);
  assertEquals(branch.failureOrder(), 0);
  assertEquals(branch.pending(), true);
  assertEquals(branch.open(), false);
  second.resolve();
  await later;
  assertEquals(branch.pending(), false);
  assertEquals(branch.open(), false);
  assertEquals(branch.chosen(), true);
  saved = false;
  assertEquals(branch.open(), false);
  assertEquals(branch.chosen(), false);
  saved = true;
  assertEquals(branch.open(), true);
});

Deno.test("every sidebar section shares identity without aliasing servers or row kinds", async () => {
  const owner = createDisclosures({});
  for (
    const kind of [
      "projectBranch",
      "archive",
      "discovered",
      "inactive",
    ] as const
  ) {
    const defaultOpen = DISCLOSURE_KINDS[kind].default;
    const branch = owner.bind(kind, repo);
    assertEquals(branch.open(), defaultOpen);
    assertEquals(branch.chosen(), false);
    await branch.set(!defaultOpen);
    assertEquals(owner.bind(kind, repo).open(), !defaultOpen);
    assertEquals(
      owner.bind(kind, { ...repo, scope: "two" }).open(),
      defaultOpen,
    );
  }
});

Deno.test("task and session disclosures isolate kind, server and id", async () => {
  const owner = createDisclosures({});
  const target = { scope: "one", id: "shared-id" };
  await owner.bind("taskHeading", target).set(false);
  assertEquals(owner.bind("taskHeading", target).open(), false);
  for (
    const [kind, other] of [
      ["sessionBranch", target],
      ["noTask", target],
      ["taskHeading", { ...target, scope: "two" }],
      ["taskHeading", { ...target, id: "another-id" }],
    ] as const
  ) {
    assertEquals(owner.bind(kind, other).open(), true);
  }
});

Deno.test("defaults follow Settings and required work unless a reader chose otherwise", async () => {
  const owner = createDisclosures({});
  let prefs = { expandSystem: false }, required = false;
  const work = owner.bind("activity", repo, {
    category: "system",
    prefs: () => prefs,
    required: () => required,
  });
  assertEquals(work.open(), false);
  prefs = { expandSystem: true };
  assertEquals(work.open(), true);
  prefs = { expandSystem: false };
  required = true;
  assertEquals(work.open(), true);
  await work.set(false);
  assertEquals(work.open(), false);
  assertEquals(work.chosen(), true);
  assertEquals(
    owner.defaultFor("tool", {
      category: "fileChanges",
      prefs: () => ({ collapseFileChanges: false }),
    }),
    true,
  );
  assertEquals(
    owner.defaultFor("revert", {
      category: "system",
      prefs: () => ({ expandSystem: true }),
    }),
    false,
  );
});

Deno.test("record choices are separate by placement and retire with the session", async () => {
  const owner = createDisclosures({});
  for (
    const [kind, category] of [
      ["reasoning", "reasoning"],
      ["tool", "toolOutput"],
      ["tool", "fileChanges"],
      ["record", "record"],
      ["record", "compaction"],
      ["activity", "work"],
      ["silent", "record"],
      ["recordKinds", "stepMarkers"],
      ["source", "source"],
    ] as const
  ) {
    const id = { ...repo, id: category + kind, generation: "one" };
    const transcript = owner.bind(kind, { ...id, placement: "transcript" }, {
      category,
    });
    const panel = owner.bind(kind, { ...id, placement: "workPanel" }, {
      category,
    });
    assertEquals([transcript.open(), panel.open()], [false, false]);
    await panel.set(true);
    assertEquals([transcript.open(), panel.open()], [false, true]);
    await panel.set(false);
    owner.reveal(kind, [id]);
    assertEquals([transcript.open(), panel.open()], [true, false]);
    owner.retire({ scope: id.scope, generation: id.generation });
    assertEquals([transcript.chosen(), panel.chosen()], [false, false]);
  }
});

Deno.test("scope retirement drops only that scope and a new generation starts from its default", async () => {
  const owner = createDisclosures({});
  const old = { ...repo, generation: "before" };
  const current = owner.bind("record", old);
  const neighbor = owner.bind("record", { ...old, scope: "two" });
  await current.set(true);
  await neighbor.set(true);
  assertEquals(
    owner.bind("record", { ...old, generation: "after" }).open(),
    false,
  );
  owner.retire({ scope: old.scope });
  assertEquals(current.open(), false);
  assertEquals(current.chosen(), false);
  assertEquals(neighbor.open(), true);
  await current.set(true);
  assertEquals(owner.bind("record", old).open(), false);
  owner.clear();
  assertEquals(neighbor.open(), false);
});

Deno.test("reveal opens only the given keys and notifies their subscribers", () => {
  const owner = createDisclosures({});
  const neighbor = { ...repo, id: "/worktree" };
  const target = owner.bind("activity", repo);
  const same = owner.bind("activity", repo);
  const other = owner.bind("activity", neighbor);
  const seen: string[] = [];
  const release = owner.subscribe(() => seen.push("target"), "activity", repo);
  owner.subscribe(() => seen.push("other"), "activity", neighbor);
  owner.reveal("activity", [repo]);
  assertEquals(target.open(), true);
  assertEquals(same.open(), true);
  assertEquals(same.chosen(), true);
  assertEquals(other.open(), false);
  assertEquals(seen, ["target"]);
  release();
  owner.retire({ kind: "activity", identity: repo });
  assertEquals(same.open(), false);
  assertEquals(seen, ["target"]);
});

Deno.test("shell bindings require a registered store for each durable kind", () => {
  const owner = createDisclosures({ durable: {} });
  assertThrows(() => owner.bind("projectBranch", repo), Error, "projectBranch");
  assertEquals(owner.bind("archive", repo).open(), false);
  assertEquals(createDisclosures({}).bind("projectBranch", repo).open(), true);
});

function row(
  directory: string,
  status: "none" | "working" | "blocked" | "finished" = "none",
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
Deno.test("branch collapse hides every child and archive regardless of status", () => {
  for (const count of [0, 1, 2, 200]) {
    const tree = projectTree([
      row("/repo"),
      ...Array.from(
        { length: count },
        (_, n) => row(`/worktree-${n}`, "working"),
      ),
    ])[0];
    const view = projectBranchPresentation(tree, false, 0);
    assertEquals(view.children.length, 0);
    assertEquals(view.bodyVisible, false);
    assertEquals(view.hasChildren, count > 0);
    assertEquals(
      projectBranchPresentation(tree, true, 0).children.length,
      count,
    );
  }
  const tree = projectTree([
    row("/repo"),
    row("/quiet"),
    row("/busy", "working"),
    row("/blocked", "blocked"),
    row("/unseen", "finished"),
  ])[0];
  assertEquals(
    projectBranchPresentation(tree, false, 1)
      .children.map((c) => c.project.directory),
    [],
  );
  assertEquals(
    projectBranchPresentation(tree, true, 1).children.map((c) =>
      c.project.directory
    ),
    ["/quiet", "/busy", "/blocked", "/unseen"],
  );
  const empty = projectTree([row("/repo")])[0];
  assertEquals(
    projectBranchPresentation(empty, false, 1)
      .archiveVisible,
    false,
  );
  assertEquals(
    projectBranchPresentation(empty, true, 1)
      .archiveVisible,
    true,
  );
  assertEquals(
    projectBranchPresentation(empty, false, 1).hasChildren,
    true,
  );
});
