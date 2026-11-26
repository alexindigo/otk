// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals } from "@std/assert";
import { UNKNOWN_REPOSITORY } from "@otk/protocol";
import {
  canRenameProject,
  checkoutLabel,
  projectLabel,
} from "../project-names.ts";

const project = {
  presentation: { id: "repo", name: "Friendly name" },
  topology: {
    repoID: "repo",
    canonicalRoot: "/home/repo",
    leafDirectory: "/home/repo",
  },
};

Deno.test("checkout and repository labels share the native project name", () => {
  const tree = "/elsewhere/feature";
  assertEquals(checkoutLabel("/home/repo", project), "Friendly name");
  assertEquals(
    checkoutLabel("/home/repo", {
      ...project,
      presentation: { id: "repo", name: "" },
    }),
    "repo",
  );
  assertEquals(checkoutLabel(tree, project), "feature");
  assertEquals(projectLabel(tree, project), "Friendly name");
  assertEquals(projectLabel(tree, { topology: project.topology }), "repo");
  assertEquals(
    projectLabel(tree, {
      topology: { ...project.topology, canonicalRoot: UNKNOWN_REPOSITORY },
    }),
    "feature",
  );
});

Deno.test("only editable known native project roots offer rename", () => {
  const row = { level: "project" as const, group: "active", summary: project };
  const capabilities = ["projectEdit"] as const;
  assertEquals(canRenameProject(row, capabilities), true);
  assertEquals(
    canRenameProject({ ...row, level: "worktree" }, capabilities),
    false,
  );
  assertEquals(
    canRenameProject({ ...row, group: "discovered" }, capabilities),
    false,
  );
  assertEquals(
    canRenameProject(
      { ...row, summary: { presentation: { id: "global" } } },
      capabilities,
    ),
    false,
  );
  assertEquals(
    canRenameProject({ ...row, summary: undefined }, capabilities),
    false,
  );
  assertEquals(canRenameProject(row, []), false);
});
