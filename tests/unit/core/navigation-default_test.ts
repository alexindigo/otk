// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals } from "@std/assert";
import type { HarnessCore } from "@otk/harness";
import type { IndexMetadata, ProjectStatus } from "@otk/protocol";
import { NavigationDefault } from "../../../core/features/navigation-default.ts";
import { SessionHierarchy } from "../../../core/index/session-hierarchy.ts";
import { ProjectIdentity } from "../../../core/index/project-identity.ts";

function entry(
  id: string,
  directory: string,
  parentID?: string,
): IndexMetadata {
  return {
    id,
    directory,
    parentID,
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
  };
}

function fixture() {
  const hierarchy = new SessionHierarchy(), identity = new ProjectIdentity();
  identity.learn([{
    directory: "/repo/src",
    sessionCount: 1,
    lastActivity: 1,
    authority: "current",
    topology: { repoID: "p", canonicalRoot: "/repo", leafDirectory: "/repo" },
  }]);
  hierarchy.configure(identity, () => [], () => false);
  const rows = [
    entry("tstv1-old", "/repo"),
    { ...entry("tstv1-new", "/repo/src"), timeUpdated: 20 },
    entry("tstv1-child", "/repo/src", "tstv1-old"),
    entry("tstv1-foreign", "/away"),
  ];
  rows.forEach((row) => hierarchy.entry(row));
  const states = new Map<string, ProjectStatus>();
  const reads: unknown[] = [];
  const core = {
    identities(ids: string[]) {
      reads.push(ids);
      return Promise.resolve(rows.filter((row) => ids.includes(row.id)));
    },
    listSessions(input: { directory: string; parentID: null; limit: number }) {
      reads.push(input);
      return Promise.resolve({
        items: rows.filter((row) =>
          row.directory === input.directory && !row.parentID
        ).sort((a, b) => b.timeUpdated - a.timeUpdated).slice(0, input.limit),
        older: null,
        generation: "test",
      });
    },
  } as unknown as HarnessCore;
  const resolver = new NavigationDefault({
    hierarchy,
    scopes: () => ["/repo", "/repo/src"],
    entries: (directory) => rows.filter((row) => row.directory === directory),
    status: (id) => states.get(id) ?? "none",
  });
  return { resolver, core, states, rows, reads };
}

Deno.test("navigation default uses existing urgency before exact child memory, then newest root across scopes", async () => {
  const f = fixture(), input = { directory: "/repo", preferred: "tstv1-child" };
  f.states.set("tstv1-old", "working");
  f.states.set("tstv1-new", "finished");
  f.states.set("tstv1-child", "blocked");
  assertEquals(await f.resolver.resolve(f.core, input), "tstv1-child");
  f.states.delete("tstv1-child");
  assertEquals(await f.resolver.resolve(f.core, input), "tstv1-new");
  f.states.delete("tstv1-new");
  assertEquals(await f.resolver.resolve(f.core, input), "tstv1-old");
  assertEquals(f.reads, [], "attention never scans a native catalog");
  f.states.clear();
  assertEquals(await f.resolver.resolve(f.core, input), "tstv1-child");
  assertEquals(f.reads, [["tstv1-child"]]);
  f.reads.length = 0;
  assertEquals(
    await f.resolver.resolve(f.core, { directory: "/repo" }),
    "tstv1-new",
  );
  assertEquals(
    f.reads,
    ["/repo", "/repo/src"].map((directory) => ({
      directory,
      parentID: null,
      limit: 1,
    })),
  );
});

Deno.test("navigation default rejects missing, foreign and deleted memories, excludes children from fresh defaults", async () => {
  const f = fixture();
  f.rows[2].timeUpdated = 100;
  for (const preferred of ["tstv1-missing", "tstv1-foreign"]) {
    assertEquals(
      await f.resolver.resolve(f.core, { directory: "/repo", preferred }),
      "tstv1-new",
    );
  }
  f.rows[2].deleted = { at: 10, how: "otk" };
  assertEquals(
    await f.resolver.resolve(f.core, {
      directory: "/repo",
      preferred: "tstv1-child",
    }),
    "tstv1-new",
  );
});
