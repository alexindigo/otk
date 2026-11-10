// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals } from "@std/assert";
import { ProjectSummaries } from "../../../core/index/project-summaries.ts";
import type { IndexMetadata, ProjectSummary } from "@otk/protocol";

const entry = (id = "tstv1-a"): IndexMetadata => ({
  id,
  directory: "/other",
  projectID: "p",
  title: id,
  timeCreated: 1,
  timeUpdated: 2,
  archived: false,
  status: "idle",
  attention: {
    permissions: 0,
    questions: 0,
    childPermissions: 0,
    childQuestions: 0,
  },
});
Deno.test("location forms retain empty worktree attention and roll it into the repository", () => {
  const owner = new ProjectSummaries(() => ({ seen: 0, finish: 0 }), () => {});
  owner.seed(["/repo", "/leaf"].map((directory) => ({
    directory,
    hasSessions: false,
    sessionCount: 0,
    lastActivity: null,
    authority: "current" as const,
    topology: {
      repoID: "repo",
      canonicalRoot: "/repo",
      leafDirectory: directory,
      ...(directory === "/leaf" ? { parentDirectory: "/repo" } : {}),
    },
  })));
  owner.locationForms({ "/leaf": 1 });
  owner.retain([]);
  assertEquals(owner.values.get("/leaf")?.locationForms, 1);
  assertEquals(owner.values.get("/leaf")?.status, "blocked");
  assertEquals(owner.values.get("/repo")?.locationForms, 1);
  assertEquals(owner.values.get("/repo")?.status, "blocked");
  assertEquals(owner.values.get("/repo")?.sessionCount, 0);
});
Deno.test("unknown population retains last-known discovery without inventing empty-session projects", () => {
  const owner = new ProjectSummaries(() => ({ seen: 0, finish: 0 }), () => {});
  owner.seed([{
    directory: "/known",
    hasSessions: true,
    sessionCount: 12,
    lastActivity: 42,
    authority: "current",
  }]);
  owner.seed([{
    directory: "/known",
    sessionCount: null,
    lastActivity: null,
    authority: "unknown",
  }, {
    directory: "/unknown",
    sessionCount: null,
    lastActivity: null,
    authority: "unknown",
  }]);
  assertEquals(owner.values.get("/known")?.hasSessions, true);
  assertEquals(owner.values.get("/known")?.sessionCount, null);
  assertEquals(owner.values.get("/unknown")?.hasSessions, undefined);
  assertEquals(owner.values.get("/unknown")?.sessionCount, null);
  assertEquals(owner.values.get("/unknown")?.lastActivity, null);
});
Deno.test("project summaries own status priority, persisted marks, recency and unavailable authority without digest", () => {
  let seen = 0, finish = 0;
  const emitted: ProjectSummary[] = [];
  const owner = new ProjectSummaries(
    (id) => id === "tstv1-a" ? ({ seen, finish }) : ({ seen: 0, finish: 0 }),
    (s) => emitted.push(s),
  );
  owner.ensure("/empty");
  assertEquals(owner.values.get("/empty")?.sessionCount, null);
  owner.authority("current");
  assertEquals(owner.values.get("/empty")?.sessionCount, 0);
  const a = entry();
  owner.entry({ ...a, status: "busy" });
  assertEquals(owner.values.get("/other")?.status, "working");
  finish = 3;
  owner.entry(a);
  assertEquals(owner.values.get("/other")?.status, "finished");
  owner.entry({ ...entry("tstv1-b"), status: "busy" });
  assertEquals(owner.values.get("/other")?.status, "finished");
  owner.entry({ ...a, attention: { ...a.attention, questions: 1 } });
  assertEquals(owner.values.get("/other")?.status, "blocked");
  seen = 4;
  owner.mark(a.id);
  owner.entry(a);
  assertEquals(owner.values.get("/other")?.unseenCount, 0);
  assertEquals(owner.values.get("/other")?.status, "working");
  owner.authority("stale");
  assertEquals(owner.values.get("/other")?.authority, "stale");
  owner.remove("tstv1-b");
  assertEquals(owner.values.get("/other")?.sessionCount, 1);
  assertEquals(owner.values.get("/other")?.status, "idle");
  const before = emitted.length;
  owner.entry(a);
  assertEquals(emitted.length, before);
});

Deno.test("@load project population seeds own counts independently of keyed hydration", () => {
  const owner = new ProjectSummaries(() => ({ seen: 0, finish: 0 }), () => {});
  owner.seed([{
    directory: "/other",
    hasSessions: true,
    sessionCount: 500,
    lastActivity: 42,
    authority: "current",
  }]);
  owner.authority("current");
  assertEquals(owner.values.get("/other")?.sessionCount, 500);
  owner.entry(entry());
  owner.entry(entry("tstv1-b"));
  assertEquals(owner.values.get("/other")?.sessionCount, 500);
  assertEquals(owner.values.get("/other")?.hasSessions, true);
  owner.authority("stale");
  assertEquals(owner.values.get("/other")?.sessionCount, 500);
  assertEquals(owner.values.get("/other")?.authority, "stale");
});

Deno.test("worktree summaries keep leaf counts and deduplicated repo rollups across nested routing and stale authority", () => {
  const owner = new ProjectSummaries(() => ({ seen: 0, finish: 0 }), () => {});
  owner.seed([
    {
      directory: "/repo",
      hasSessions: true,
      sessionCount: 2,
      lastActivity: 4,
      authority: "current",
      topology: { repoID: "p", canonicalRoot: "/repo", leafDirectory: "/repo" },
    },
    {
      directory: "/trees/one",
      hasSessions: true,
      sessionCount: 3,
      lastActivity: 6,
      authority: "current",
      topology: {
        repoID: "p",
        canonicalRoot: "/repo",
        leafDirectory: "/trees/one",
        parentDirectory: "/repo",
      },
    },
    {
      directory: "/trees/one/src",
      hasSessions: true,
      sessionCount: 1,
      lastActivity: 7,
      authority: "current",
      topology: {
        repoID: "p",
        canonicalRoot: "/repo",
        leafDirectory: "/trees/one",
        parentDirectory: "/repo",
      },
    },
  ]);
  owner.authority("current");
  owner.entry({ ...entry(), directory: "/trees/one/src", status: "busy" });
  assertEquals(owner.values.get("/trees/one")?.status, "working");
  assertEquals(owner.values.get("/trees/one")?.sessionCount, 4);
  assertEquals(owner.values.get("/trees/one")?.scopes, [
    "/trees/one",
    "/trees/one/src",
  ]);
  assertEquals(owner.values.get("/repo")?.scopes, ["/repo"]);
  assertEquals(owner.values.get("/repo")?.sessionCount, 6);
  assertEquals(owner.values.get("/repo")?.direct?.sessionCount, 2);
  assertEquals(owner.values.get("/repo")?.status, "working");
  assertEquals(owner.leaf("/trees/one/lib", "p"), "/trees/one");
  assertEquals(owner.leaf("/trees/one/lib", "other"), "/trees/one/lib");
  assertEquals(owner.values.has("/trees/one/src"), false);
  owner.authority("stale");
  assertEquals(owner.values.get("/repo")?.status, "working");
  assertEquals(owner.values.get("/repo")?.authority, "stale");
  owner.seed([{
    directory: "/trees/one",
    hasSessions: true,
    sessionCount: 4,
    lastActivity: 7,
    authority: "current",
    topology: {
      repoID: "p",
      canonicalRoot: "/new-repo",
      leafDirectory: "/trees/one",
      parentDirectory: "/new-repo",
    },
  }, {
    directory: "/trees/one/src",
    hasSessions: false,
    sessionCount: 0,
    lastActivity: null,
    authority: "current",
    topology: {
      repoID: "p",
      canonicalRoot: "/new-repo",
      leafDirectory: "/trees/one",
      parentDirectory: "/new-repo",
    },
  }]);
  assertEquals(owner.values.get("/repo")?.status, "idle");
  assertEquals(owner.values.get("/repo")?.sessionCount, 2);
  assertEquals(owner.values.get("/new-repo")?.status, "working");
});

Deno.test("topology outlives population-only seeds; explicit clear retires only the relationship and empty inventory stays unmaterialized", () => {
  const owner = new ProjectSummaries(() => ({ seen: 0, finish: 0 }), () => {});
  const topology = {
    repoID: "p",
    canonicalRoot: "/repo",
    leafDirectory: "/tree",
    parentDirectory: "/repo",
  };
  owner.ensure("/tree");
  owner.seed([{
    directory: "/tree",
    hasSessions: true,
    sessionCount: 1,
    lastActivity: 1,
    authority: "current",
    topology,
  }]);
  owner.seed([{
    directory: "/tree",
    hasSessions: false,
    sessionCount: 0,
    lastActivity: null,
    authority: "current",
  }]);
  assertEquals(owner.values.get("/tree")?.topology, topology);
  assertEquals(owner.values.get("/tree")?.sessionCount, 0);
  owner.seed([{
    directory: "/tree",
    hasSessions: false,
    sessionCount: 0,
    lastActivity: null,
    authority: "current",
    topology: null,
  }]);
  assertEquals(owner.values.get("/tree")?.topology, undefined);
  owner.seed([{
    directory: "/empty",
    hasSessions: false,
    sessionCount: 0,
    lastActivity: null,
    authority: "current",
    topology: {
      repoID: "empty",
      canonicalRoot: "/empty",
      leafDirectory: "/empty",
    },
  }]);
  assertEquals(owner.values.has("/empty"), false);
  owner.ensure("/empty");
  assertEquals(owner.values.get("/empty")?.topology?.repoID, "empty");
});

Deno.test("known nested scopes retain their checkout row and exact source scope after the last native session disappears", () => {
  const owner = new ProjectSummaries(() => ({ seen: 0, finish: 0 }), () => {});
  const topology = {
    repoID: "p",
    canonicalRoot: "/repo",
    leafDirectory: "/tree",
    parentDirectory: "/repo",
  };
  owner.seed([{
    directory: "/tree/src",
    hasSessions: true,
    sessionCount: 1,
    lastActivity: 1,
    authority: "current",
    topology,
  }]);
  owner.ensure("/tree/src");
  owner.seed([{
    directory: "/tree/src",
    hasSessions: false,
    sessionCount: 0,
    lastActivity: null,
    authority: "current",
  }]);
  assertEquals(owner.values.has("/tree/src"), false);
  assertEquals(owner.values.get("/tree")?.scopes, ["/tree", "/tree/src"]);
  assertEquals(owner.values.get("/tree")?.sessionCount, 0);
});
