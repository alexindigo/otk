// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals, assertRejects } from "@std/assert";
import {
  projectPresentation,
  readProject,
  readRepository,
} from "../project-presentation.ts";
import type { V2Client } from "../client.ts";

Deno.test("V2 project presentation preserves native identity and avatar precedence", () => {
  const base = {
    id: "repo",
    canonical: "/repo",
    name: "Native name",
    vcs: "git",
  };
  assertEquals(projectPresentation(base), {
    id: "repo",
    root: "/repo",
    name: "Native name",
    icon: undefined,
    color: undefined,
    repository: "Local repository",
  });
  assertEquals(
    projectPresentation({
      ...base,
      icon: { color: "blue", url: "https://example.com/icon.png" },
    }).icon,
    undefined,
  );
  assertEquals(
    projectPresentation({ ...base, icon: { color: "blue" } }).color,
    "#3250df",
  );
  assertEquals(
    projectPresentation({ ...base, icon: { color: "unreported-color" } }).color,
    undefined,
  );
  assertEquals(
    projectPresentation({
      ...base,
      icon: { color: "blue", override: "data:image/png;base64,AA==" },
    }).icon,
    "data:image/png;base64,AA==",
  );
  assertEquals(
    projectPresentation({ id: "global", canonical: "/" }).root,
    undefined,
  );
  assertEquals(
    projectPresentation({ id: "global", canonical: "/" }).repository,
    undefined,
  );
});

Deno.test("V2 project and repository reads use native location ownership and current facts", async () => {
  const project = {
    id: "repo",
    canonical: "/repo",
    name: "Native",
    vcs: "git",
  };
  const api = {
    server: { info: () => Promise.resolve({ hostname: "native-host" }) },
    location: { get: () => Promise.resolve({ project: { id: "repo" } }) },
    project: {
      list: () => Promise.resolve([{ ...project, id: "foreign" }, project]),
    },
    vcs: {
      get: () =>
        Promise.resolve({
          data: { provider: "git", branch: { current: "topic" } },
        }),
      status: () => Promise.resolve({ data: [{ file: "file.txt" }] }),
    },
  };
  const client = {
    read: (read: (api: unknown) => Promise<unknown>) => read(api),
  } as unknown as V2Client;
  const signal = new AbortController().signal;
  assertEquals(await readProject(client, "/repo/subdirectory", signal), [
    { ...projectPresentation(project), machine: "native-host" },
  ]);
  assertEquals(await readRepository(client, "/repo/subdirectory", signal), [{
    branch: "topic",
    changes: "1 changed file",
  }]);
  api.vcs.status = () => Promise.resolve({ data: [] });
  assertEquals(await readRepository(client, "/repo", signal), [{
    branch: "topic",
    changes: "No changes",
  }]);
  api.vcs.status = () => Promise.reject(new Error("Unavailable status"));
  await assertRejects(
    () => readRepository(client, "/repo", signal),
    Error,
    "Unavailable status",
  );
});
