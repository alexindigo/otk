// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals, assertRejects } from "@std/assert";
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
    listSessions(input: { directory: string; parentID?: null; limit: number }) {
      reads.push(input);
      return Promise.resolve({
        items: rows.filter((row) =>
          row.directory === input.directory &&
          (input.parentID !== null || !row.parentID)
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
  return { resolver, core, states, rows, reads, hierarchy, identity };
}

Deno.test("explicit checkout and repository attention targets never redirect to a foreign human root", async () => {
  const f = fixture();
  f.identity.learn([{
    directory: "/tree",
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
  const child = entry("tstv1-failed", "/tree", "tstv1-old");
  f.rows.push(child);
  f.hierarchy.entry(child);
  f.states.set(child.id, "blocked");
  const resolver = new NavigationDefault({
    hierarchy: f.hierarchy,
    scopes: (directory, repository) =>
      repository ? ["/repo", "/repo/src", "/tree"] : [directory],
    entries: (directory) => f.rows.filter((row) => row.directory === directory),
    status: (id) => f.states.get(id) ?? "none",
  });
  assertEquals(
    await resolver.resolve(f.core, { directory: "/tree" }),
    child.id,
  );
  assertEquals(
    await resolver.resolve(f.core, { directory: "/repo", attention: true }),
    child.id,
  );
  // Ordinary project-name clicks still obey decision 56.
  f.states.set("tstv1-child", "blocked");
  assertEquals(
    await f.resolver.resolve(f.core, { directory: "/repo" }),
    "tstv1-old",
  );
  f.states.clear();
  assertEquals(
    await resolver.resolve(f.core, { directory: "/tree" }),
    child.id,
  );
  assertEquals(
    await resolver.resolve(f.core, { directory: "/tree", preferred: child.id }),
    child.id,
  );
});

Deno.test("project memory preserves exact selection before attention and fresh defaults", async () => {
  const f = fixture(), input = { directory: "/repo", preferred: "tstv1-child" };
  f.states.set("tstv1-old", "working");
  f.states.set("tstv1-new", "finished");
  f.states.set("tstv1-child", "blocked");
  assertEquals(await f.resolver.resolve(f.core, input), "tstv1-child");
  f.states.delete("tstv1-child");
  assertEquals(await f.resolver.resolve(f.core, input), "tstv1-child");
  f.states.delete("tstv1-new");
  assertEquals(await f.resolver.resolve(f.core, input), "tstv1-child");
  f.reads.length = 0;
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

Deno.test("archive retains memory and explicit attention alone overrides a remembered destination", async () => {
  const f = fixture();
  f.rows[0].archived = true;
  f.states.set("tstv1-new", "blocked");
  assertEquals(
    await f.resolver.resolve(f.core, {
      directory: "/repo",
      preferred: "tstv1-old",
    }),
    "tstv1-old",
  );
  assertEquals(
    await f.resolver.resolve(f.core, {
      directory: "/repo",
      preferred: "tstv1-old",
      attention: true,
    }),
    "tstv1-new",
  );
});

Deno.test("navigation urgency still chooses finished over working despite the working rollup lamp", async () => {
  const f = fixture();
  f.states.set("tstv1-old", "working");
  f.states.set("tstv1-new", "finished");
  assertEquals(
    await f.resolver.resolve(f.core, { directory: "/repo" }),
    "tstv1-new",
  );
  f.states.set("tstv1-old", "blocked");
  assertEquals(
    await f.resolver.resolve(f.core, { directory: "/repo" }),
    "tstv1-old",
  );
  assertEquals(
    f.reads,
    [],
    "urgency consumes complete hierarchy proof without redundant native reads",
  );
});

for (const change of ["deleted", "moved", "parented"] as const) {
  Deno.test(`navigation default revalidates ${change} roots after later scope reads`, async () => {
    const f = fixture(),
      reached = Promise.withResolvers<void>(),
      release = Promise.withResolvers<void>();
    f.rows[0].timeUpdated = 100;
    const list = f.core.listSessions.bind(f.core);
    f.core.listSessions = async (input, signal) => {
      if (input.directory === "/repo/src") {
        reached.resolve();
        await release.promise;
      }
      return await list(input, signal);
    };
    const pending = f.resolver.resolve(f.core, { directory: "/repo" });
    await reached.promise;
    if (change === "deleted") f.rows[0].deleted = { at: 10, how: "otk" };
    else if (change === "moved") f.rows[0].directory = "/away";
    else f.rows[0].parentID = "tstv1-new";
    f.hierarchy.entry(f.rows[0]);
    release.resolve();
    assertEquals(await pending, "tstv1-new");
  });
}

for (const ancestry of ["missing", "cyclic"] as const) {
  for (const candidate of ["attention", "remembered"] as const) {
    Deno.test(`navigation preserves explicit memory but rejects ${ancestry} default ${candidate} ancestry`, async () => {
      const f = fixture();
      f.rows[2].parentID = ancestry === "missing"
        ? "tstv1-absent"
        : f.rows[2].id;
      f.hierarchy.entry(f.rows[2]);
      if (candidate === "attention") f.states.set(f.rows[2].id, "blocked");
      assertEquals(
        await f.resolver.resolve(f.core, {
          directory: "/repo",
          ...(candidate === "remembered" ? { preferred: f.rows[2].id } : {}),
        }),
        candidate === "remembered" ? f.rows[2].id : "tstv1-new",
      );
    });
  }
}

Deno.test("navigation with no proven human root returns no default, never a helper", async () => {
  const f = fixture();
  for (const row of f.rows.filter((row) => row.directory !== "/away")) {
    row.parentID = row.id;
    f.hierarchy.entry(row);
  }
  f.states.set("tstv1-child", "blocked");
  assertEquals(
    await f.resolver.resolve(f.core, {
      directory: "/repo",
    }),
    null,
  );
});

Deno.test("navigation revalidates cancellation before returning a cached proven root", async () => {
  const f = fixture(), controller = new AbortController();
  f.states.set("tstv1-child", "blocked");
  const pending = f.resolver.resolve(
    f.core,
    { directory: "/repo" },
    controller.signal,
  );
  controller.abort();
  await assertRejects(() => pending, DOMException);
});

Deno.test("navigation uses late proven ancestry rather than returning an unresolved helper", async () => {
  const f = fixture();
  f.rows[2].parentID = "tstv1-late";
  f.hierarchy.entry(f.rows[2]);
  f.states.set(f.rows[2].id, "blocked");
  const identities = f.core.identities.bind(f.core);
  f.core.identities = async (ids, signal) => {
    if (ids.includes("tstv1-late")) {
      return [{ id: "tstv1-late", directory: "/repo" }];
    }
    return await identities(ids, signal);
  };
  assertEquals(
    await f.resolver.resolve(f.core, {
      directory: "/repo",
    }),
    "tstv1-late",
  );
});

for (const change of ["deleted", "moved", "cyclic"] as const) {
  Deno.test(`navigation revalidates ${change} attention after ancestry acquisition`, async () => {
    const f = fixture(),
      held = Promise.withResolvers<void>(),
      reached = Promise.withResolvers<void>();
    const child = f.rows[2];
    child.parentID = "tstv1-late";
    f.hierarchy.entry(child);
    f.states.set(child.id, "blocked");
    const identities = f.core.identities.bind(f.core);
    f.core.identities = async (ids, signal) => {
      if (ids.includes("tstv1-late")) {
        reached.resolve();
        await held.promise;
        return [{ id: "tstv1-late", directory: "/repo" }];
      }
      return await identities(ids, signal);
    };
    const pending = f.resolver.resolve(f.core, { directory: "/repo" });
    await reached.promise;
    if (change === "deleted") child.deleted = { at: 10, how: "otk" };
    else if (change === "moved") child.directory = "/away";
    else child.parentID = child.id;
    f.hierarchy.entry(child);
    held.resolve();
    assertEquals(await pending, "tstv1-new");
  });
}
