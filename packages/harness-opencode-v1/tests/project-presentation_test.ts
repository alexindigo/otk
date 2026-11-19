// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals, assertRejects } from "@std/assert";
import {
  projectPresentation,
  readProject,
  readRepository,
} from "../project-presentation.ts";
import type { Client } from "../client.ts";

Deno.test("V1 project presentation does not invent fields absent in older natives", () => {
  const value = projectPresentation({
    id: "repo",
    worktree: "/repo",
    vcs: "git",
  });
  assertEquals(value, {
    id: "repo",
    root: "/repo",
    name: undefined,
    icon: undefined,
    color: undefined,
    repository: "Local repository",
  });
  assertEquals(
    projectPresentation({ id: "global", worktree: "/" }).root,
    undefined,
  );
  assertEquals(
    projectPresentation({
      id: "repo",
      worktree: "/repo",
      icon: { color: "blue" },
    }).color,
    "#3250df",
  );
  assertEquals(
    projectPresentation({
      id: "repo",
      worktree: "/repo",
      icon: { color: "blue", override: "native-image" },
    }).icon,
    "native-image",
  );
});

Deno.test("V1 project and repository presentation only report successful native facts", async () => {
  const project = {
    id: "repo",
    worktree: "/repo",
    name: "Native name",
    vcs: "git",
  };
  let changed = 0, fail = false;
  const paths: string[] = [];
  const client = {
    json: (path: string) => {
      paths.push(path);
      if (path === "/project/current") return Promise.resolve(project);
      if (path === "/vcs") return Promise.resolve({ branch: "topic" });
      if (fail) return Promise.reject(new Error("Unavailable status"));
      return Promise.resolve(
        Array.from({ length: changed }, () => ({ path: "file" })),
      );
    },
  } as unknown as Client;
  const signal = new AbortController().signal;
  assertEquals(await readProject(client, "/repo", signal), [
    projectPresentation(project),
  ]);
  assertEquals(await readRepository(client, "/repo", signal), [{
    branch: "topic",
    changes: "No changes",
  }]);
  changed = 2;
  assertEquals(await readRepository(client, "/repo", signal), [{
    branch: "topic",
    changes: "2 changed files",
  }]);
  fail = true;
  await assertRejects(
    () => readRepository(client, "/repo", signal),
    Error,
    "Unavailable status",
  );
  assertEquals(paths[0], "/project/current");
});
