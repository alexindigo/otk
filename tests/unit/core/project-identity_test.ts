// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals } from "@std/assert";
import type { ProjectSeed } from "@otk/harness";
import { ProjectIdentity } from "../../../core/index/project-identity.ts";

Deno.test("removal requires recorded worktree kind and current inventory, not unequal paths", () => {
  for (const kind of ["checkout", "worktree", "unknown"] as const) {
    const owner = new ProjectIdentity();
    const seed: ProjectSeed = {
      directory: "/other/src",
      sessionCount: 1,
      lastActivity: 1,
      authority: "current",
      identities: [{
        source: "native",
        repoID: "repo",
        canonicalRoot: "/repo",
        recordedRoot: "/other",
        inventory: [{ directory: "/other", kind }],
      }],
    };
    owner.learn([seed]);
    owner.learn([{
      ...seed,
      identities: [{ ...seed.identities![0], inventory: [] }],
    }]);
    assertEquals(
      owner.availability("/other"),
      kind === "worktree" ? "removed" : "unknown",
    );
    assertEquals(owner.archived("/other"), kind === "worktree");
    assertEquals(owner.memberships("/other")[0].inventory, "current");
    const restarted = new ProjectIdentity({
      list: () => owner.records(),
      save: () => {},
    });
    assertEquals(restarted.availability("/other"), "unknown");
    assertEquals(restarted.archived("/other"), false);
    owner.learn([{ ...seed, topology: null, identities: undefined }]);
    assertEquals(owner.availability("/other"), "unknown");
    assertEquals(owner.archived("/other"), false);
    owner.learn([{
      ...seed,
      identities: [{ ...seed.identities![0], inventory: undefined }],
    }]);
    assertEquals(owner.availability("/other"), "unknown");
  }
});

Deno.test("checkout kind belongs to the recorded leaf, not its reused session scope", () => {
  const owner = new ProjectIdentity();
  const seed: ProjectSeed = {
    directory: "/shared/src",
    sessionCount: 1,
    lastActivity: 1,
    authority: "current",
    identities: [{
      source: "native",
      repoID: "repo",
      canonicalRoot: "/repo",
      recordedRoot: "/old",
      inventory: [{ directory: "/old", kind: "worktree" }],
    }],
  };
  owner.learn([seed]);
  owner.learn([{
    ...seed,
    identities: [{
      ...seed.identities![0],
      recordedRoot: "/new",
      inventory: [],
    }],
  }]);
  assertEquals(owner.memberships("/new")[0].kind, "unknown");
  assertEquals(owner.availability("/new"), "unknown");
  assertEquals(owner.archived("/new"), false);
});

Deno.test("non-Git folders, canonical roots and cold historical roots are never inferred removed", () => {
  for (const directory of ["/folder", "/repo", "/repo/nested"]) {
    const owner = new ProjectIdentity();
    owner.learn([{
      directory,
      sessionCount: 1,
      lastActivity: 1,
      authority: "current",
      identities: [{
        source: "native",
        repoID: "repo",
        canonicalRoot: directory === "/folder" ? "" : "/repo",
        recordedRoot: directory,
        inventory: [],
      }],
    }]);
    assertEquals(owner.availability(directory), "unknown");
  }
});
