// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals } from "@std/assert";
import type { ProjectSeed } from "@otk/harness";
import { Checkouts, checkoutsMigrations, OtkDb } from "@otk/store";
import { ProjectIdentity } from "../../../core/index/project-identity.ts";
import { tempDir, test } from "../../support/resources.ts";

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

const shared = { key: "github.com/org/repo", owner: "org" };
function remoteFact(
  directory: string,
  repo: string,
  remote?: Evidence["remote"],
  canonical = directory,
  root = directory,
): ProjectSeed {
  const seed = selfClaim(directory, repo, {
    root,
    remote,
    present: true,
    evidence: "git",
  });
  return {
    ...seed,
    identities: seed.identities!.map((fact) => ({
      ...fact,
      canonicalRoot: canonical,
    })),
  };
}

test("D84 remote evidence preserves native IDs and retains anchors across missing reads and restarts", async () => {
  const state = await tempDir("remote-identity-");
  const db = new OtkDb(state, [checkoutsMigrations], { busyms: 0 });
  try {
    const store = new Checkouts(db);
    const identity = new ProjectIdentity(store);
    const main = "/longer-primary", clone = "/b", linked = "/b.linked";
    identity.learn([remoteFact(clone, "clone-id", shared, main)]);
    assertEquals(identity.topology(clone)?.canonicalRoot, clone);
    assertEquals(identity.owner(clone), "org");
    const affected = identity.learn([
      remoteFact(clone, "clone-id", shared, main),
      remoteFact(main, "main-id", shared),
      remoteFact(linked, "clone-id", shared, main, clone),
      remoteFact(
        "/different",
        "main-id",
        { key: "aur.archlinux.org/repo" },
        main,
      ),
      remoteFact("/no-remote", "main-id", null, main),
    ]);
    assertEquals(identity.topology(clone), {
      repoID: "clone-id",
      group: shared.key,
      canonicalRoot: main,
      leafDirectory: clone,
      parentDirectory: main,
    });
    assertEquals(identity.topology(linked)?.parentDirectory, main);
    assertEquals(identity.topology(main)?.group, shared.key);
    assertEquals(identity.topology("/different")?.canonicalRoot, "/different");
    assertEquals(identity.owner("/different"), undefined);
    assertEquals(identity.topology("/no-remote")?.canonicalRoot, "/no-remote");
    assertEquals(
      [main, clone, linked].every((path) => affected.directories.has(path)),
      true,
    );
    identity.learn([
      remoteFact(main, "main-id"),
      remoteFact(clone, "clone-id", undefined, main),
    ]);
    assertEquals(identity.topology(clone)?.canonicalRoot, main);
    assertEquals(
      new ProjectIdentity(store).topology(clone)?.canonicalRoot,
      main,
    );
    identity.learn([selfClaim(clone, "clone-id", gone("none"))]);
    assertEquals(identity.archived(clone), true);
    identity.learn([remoteFact(clone, "clone-id", shared, main)]);
    identity.learn([selfClaim(main, "main-id", gone("none"))]);
    assertEquals(identity.archived(main), true);
    assertEquals(identity.topology(main)?.parentDirectory, clone);
    assertEquals(identity.topology(linked)?.parentDirectory, clone);
    const cold = new ProjectIdentity(store);
    const byLeaf = (identity: ProjectIdentity) =>
      Object.fromEntries(
        identity.topologies().map((t) => [t.leafDirectory, t]),
      );
    assertEquals(byLeaf(cold), byLeaf(identity));
    assertEquals(
      cold.archived(main),
      false,
      "absence is not current after restart",
    );
  } finally {
    db.close();
  }
});

Deno.test("D84 ties use first_seen, then shortest and lexical path without changing an existing anchor", () => {
  const old = "/earliest", short = "/z", equal = "/a";
  const facts = [
    remoteFact(short, "short", shared, "/unrelated"),
    remoteFact(equal, "equal", shared, "/unrelated"),
    remoteFact(old, "old", shared, "/unrelated"),
  ];
  const fixture = (firstSeen: number) =>
    new ProjectIdentity({
      list: () => [],
      save: () => {},
      remotes: () => [
        { repository: old, remote: shared.key, firstSeen, readAt: firstSeen },
        ...[short, equal].map((repository) => ({
          repository,
          remote: shared.key,
          firstSeen: 2,
          readAt: 2,
        })),
      ],
    });
  const earliest = fixture(1);
  earliest.learn(facts);
  assertEquals(earliest.topology(equal)?.canonicalRoot, old);
  const tied = fixture(2);
  tied.learn(facts);
  assertEquals(tied.topology(old)?.canonicalRoot, equal);
  tied.learn([remoteFact("/preferred", "preferred", shared)]);
  assertEquals(tied.topology("/preferred")?.canonicalRoot, equal);
});

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

Deno.test("a stable native scope does not carry Git evidence to a different checkout leaf", () => {
  const owner = new ProjectIdentity();
  const observed = selfClaim("/scope", "native-id");
  const [fact] = observed.identities!;
  owner.learn([{
    ...observed,
    identities: [{
      ...fact,
      recordedRoot: "/old",
      repository: { checkout: "/old", ...gone("worktree-metadata", "/git") },
    }],
  }]);
  assertEquals(owner.archived("/old"), true);
  owner.learn([{
    ...observed,
    identities: [{
      ...fact,
      canonicalRoot: "/new",
      recordedRoot: "/new",
      inventory: [{ directory: "/new", kind: "checkout" }],
    }],
  }]);
  assertEquals(owner.records()[0].repository, undefined);
  assertEquals(owner.topology("/new")?.canonicalRoot, "/new");
  assertEquals(owner.availability("/new"), "present");
  assertEquals(owner.memberships("/new")[0].kind, "checkout");
  assertEquals(owner.archived("/new"), false);
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
    group: "repo:main",
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
