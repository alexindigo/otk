// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals } from "@std/assert";
import type { ProjectSeed } from "@otk/harness";
import { ProjectIdentity } from "../../../core/index/project-identity.ts";

type Evidence = NonNullable<
  NonNullable<ProjectSeed["identities"]>[number]["repository"]
>;
const UNKNOWN = "otk:unknown-repository";
/** A native that claims a removed checkout is its own, still present, project. */
function selfClaim(
  directory: string,
  repoID: string,
  repository?: Omit<Evidence, "checkout">,
): ProjectSeed {
  return {
    directory,
    sessionCount: 2,
    lastActivity: 1,
    authority: "current",
    identities: [{
      source: "native",
      repoID,
      canonicalRoot: directory,
      recordedRoot: directory,
      inventory: [{ directory, kind: "checkout" }],
      ...(repository
        ? { repository: { checkout: directory, ...repository } }
        : {}),
    }],
  };
}
const gone = (
  evidence: Evidence["evidence"],
  root: string | null = null,
) => ({ root, present: false, evidence });

Deno.test("a discovered repository survives removal, restart and the native's stale self-claim", () => {
  let rows: import("@otk/store").CheckoutRecord[] = [];
  const history = { list: () => rows, save: () => {} };
  const owner = new ProjectIdentity(history);
  owner.learn([selfClaim("/repo.review", "obsolete", {
    root: "/repo",
    present: true,
    evidence: "git",
  })]);
  assertEquals(owner.topology("/repo.review")?.parentDirectory, "/repo");
  assertEquals(owner.archived("/repo.review"), false);
  rows = owner.records();
  const cold = new ProjectIdentity(history);
  // Before new evidence arrives the recorded repository already places it.
  assertEquals(cold.topology("/repo.review")?.canonicalRoot, "/repo");
  cold.learn([selfClaim("/repo.review", "obsolete")]);
  assertEquals(cold.topology("/repo.review")?.canonicalRoot, "/repo");
  // Removed and unregistered: the recorded repository is not re-derived.
  cold.learn([selfClaim("/repo.review", "obsolete", gone("none"))]);
  assertEquals(cold.topology("/repo.review")?.parentDirectory, "/repo");
  assertEquals(cold.availability("/repo.review"), "removed");
  assertEquals(cold.archived("/repo.review"), true);
  assertEquals(cold.memberships("/repo.review")[0].repoID, "obsolete");
});

Deno.test("already lost affiliation is recovered from retained Git registration first", () => {
  const owner = new ProjectIdentity();
  owner.learn([selfClaim("/repo.review", "obsolete")]);
  assertEquals(owner.topology("/repo.review")?.parentDirectory, undefined);
  owner.learn([
    selfClaim("/repo.review", "obsolete", gone("worktree-metadata", "/repo")),
  ]);
  assertEquals(owner.topology("/repo.review")?.parentDirectory, "/repo");
  assertEquals(owner.archived("/repo.review"), true);
  assertEquals(owner.records()[0].repository, "/repo");
});

Deno.test("stored affiliation outranks naming, and naming applies only as a last resort", () => {
  const owner = new ProjectIdentity();
  const claimed: ProjectSeed = {
    directory: "/other.run",
    sessionCount: 1,
    lastActivity: 1,
    authority: "current",
    identities: [{
      source: "native",
      repoID: "repo",
      canonicalRoot: "/repo",
      recordedRoot: "/other.run",
      inventory: [{ directory: "/other.run", kind: "worktree" }],
    }],
  };
  owner.learn([claimed]);
  owner.learn([{
    ...claimed,
    identities: [{
      ...claimed.identities![0],
      repository: { checkout: "/other.run", ...gone("name", "/other") },
    }],
  }]);
  assertEquals(owner.topology("/other.run")?.canonicalRoot, "/repo");
  const named = new ProjectIdentity();
  named.learn([selfClaim("/repo.review", "obsolete", gone("name", "/repo"))]);
  assertEquals(named.topology("/repo.review")?.parentDirectory, "/repo");
  assertEquals(named.archived("/repo.review"), true);
});

Deno.test("an undeterminable removed checkout is placed under unknown repository, never as a project", () => {
  const owner = new ProjectIdentity();
  owner.learn([selfClaim("/lost", "lost", gone("none"))]);
  const topology = owner.topology("/lost")!;
  assertEquals(topology.canonicalRoot, UNKNOWN);
  assertEquals(topology.parentDirectory, undefined);
  assertEquals(owner.archived("/lost"), true);
  // Unknown is not final: later recovery evidence still resolves it.
  owner.learn([selfClaim("/lost", "lost", gone("name", "/lo"))]);
  assertEquals(owner.topology("/lost")?.canonicalRoot, "/lo");
});

Deno.test("a later batch's stale native inventory does not revive a removed checkout", () => {
  const owner = new ProjectIdentity();
  const root = (inventory: string[]): ProjectSeed => ({
    directory: "/repo",
    sessionCount: 1,
    lastActivity: 1,
    authority: "current",
    identities: [{
      source: "native",
      repoID: "repo",
      canonicalRoot: "/repo",
      recordedRoot: "/repo",
      inventory: inventory.map((directory) => ({
        directory,
        kind: directory === "/repo" ? "checkout" : "worktree",
      })),
    }],
  });
  const stale = ["/repo", "/repo.a"];
  owner.learn([{
    ...root(stale),
    directory: "/repo.a",
    identities: [{
      ...root(stale).identities![0],
      recordedRoot: "/repo.a",
      repository: {
        checkout: "/repo.a",
        ...gone("worktree-metadata", "/repo"),
      },
    }],
  }]);
  assertEquals(owner.availability("/repo.a"), "removed");
  owner.learn([root(stale)]);
  assertEquals(owner.availability("/repo.a"), "removed");
  assertEquals(owner.archived("/repo.a"), true);
});

Deno.test("checkouts of one repository share its topology across native project IDs", () => {
  const owner = new ProjectIdentity();
  owner.learn([
    selfClaim("/repo", "main", {
      root: "/repo",
      present: true,
      evidence: "git",
    }),
    selfClaim("/repo.a", "other", {
      root: "/repo",
      present: true,
      evidence: "git",
    }),
  ]);
  assertEquals(owner.topology("/repo.a"), {
    repoID: "main",
    canonicalRoot: "/repo",
    leafDirectory: "/repo.a",
    parentDirectory: "/repo",
  });
  assertEquals(owner.topology("/repo")?.repoID, "main");
});

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
    assertEquals(owner.availability("/other"), "present");
    assertEquals(owner.archived("/other"), false);
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
    assertEquals(owner.memberships("/other")[0].kind, kind);
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

Deno.test("an unproven recorded worktree cannot become removed from inventory absence", () => {
  const owner = new ProjectIdentity({
    list: () => [{
      source: "native",
      repoID: "repo",
      scope: "/unproven",
      canonicalRoot: "/repo",
      leafDirectory: "/unproven",
      kind: "worktree",
      proven: false,
      availability: "unknown",
    }],
    save: () => {},
  });
  owner.learn([{
    directory: "/unproven",
    sessionCount: 1,
    lastActivity: 1,
    authority: "current",
    identities: [{
      source: "native",
      repoID: "repo",
      canonicalRoot: "/repo",
      recordedRoot: null,
      inventory: [],
    }],
  }]);
  assertEquals(owner.availability("/unproven"), "unknown");
  assertEquals(owner.archived("/unproven"), false);
});
