// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals } from "@std/assert";
import { join } from "@std/path";
import { CheckoutRepositories } from "../checkout-repositories.ts";
import type { ProjectSeed } from "../types.ts";

/** A repository with one registered worktree, laid out as Git writes it. */
async function layout(base: string) {
  const repo = join(base, "repo");
  await Deno.mkdir(join(repo, ".git", "worktrees", "repo.live"), {
    recursive: true,
  });
  await Deno.mkdir(join(repo, ".git", "worktrees", "repo.removed"), {
    recursive: true,
  });
  for (const name of ["repo.live", "repo.removed"]) {
    const meta = join(repo, ".git", "worktrees", name);
    await Deno.writeTextFile(join(meta, "gitdir"), join(base, name, ".git"));
    await Deno.writeTextFile(join(meta, "commondir"), "../..\n");
  }
  await Deno.mkdir(join(base, "repo.live"));
  await Deno.writeTextFile(
    join(base, "repo.live", ".git"),
    `gitdir: ${join(repo, ".git", "worktrees", "repo.live")}\n`,
  );
  await Deno.mkdir(join(base, "folder"));
  return repo;
}
const seed = (directory: string, canonicalRoot?: string): ProjectSeed => ({
  directory,
  sessionCount: 1,
  lastActivity: 1,
  authority: "current",
  identities: [{
    source: "native",
    repoID: "native-id",
    canonicalRoot,
    recordedRoot: directory,
  }],
});

Deno.test("checkout repositories come from Git, then registration, then unique naming", async () => {
  const base = await Deno.makeTempDir();
  try {
    const repo = await layout(base);
    const owner = await CheckoutRepositories.discover([repo, base + "/gone"]);
    const at = (name: string) => join(base, name);
    const rows = await owner.seeds([
      seed(repo, repo),
      seed(at("repo.live"), at("repo.live")),
      seed(at("repo.removed"), at("repo.removed")),
      seed(at("repo.run05"), at("repo.run05")),
      seed(at("other.run05"), at("other.run05")),
      seed(at("repo."), at("repo.")),
      seed(at("folder"), at("folder")),
      seed(at("repo.global")),
    ], new AbortController().signal);
    assertEquals(rows.map((row) => row.identities![0].repository), [
      { checkout: repo, root: repo, present: true, evidence: "git" },
      { checkout: at("repo.live"), root: repo, present: true, evidence: "git" },
      {
        checkout: at("repo.removed"),
        root: repo,
        present: false,
        evidence: "worktree-metadata",
      },
      {
        checkout: at("repo.run05"),
        root: repo,
        present: false,
        evidence: "name",
      },
      {
        checkout: at("other.run05"),
        root: null,
        present: false,
        evidence: "none",
      },
      { checkout: at("repo."), root: null, present: false, evidence: "none" },
      undefined,
      undefined,
    ]);
  } finally {
    await Deno.remove(base, { recursive: true });
  }
});

Deno.test("naming names no repository when several discovered repositories match", async () => {
  const base = await Deno.makeTempDir();
  try {
    for (const name of ["a", "a.b"]) {
      await Deno.mkdir(join(base, name, ".git"), { recursive: true });
    }
    const owner = await CheckoutRepositories.discover([
      join(base, "a"),
      join(base, "a.b"),
    ]);
    const [row] = await owner.seeds(
      [seed(join(base, "a.b.c"), join(base, "a.b.c"))],
      new AbortController().signal,
    );
    assertEquals(row.identities![0].repository?.root, null);
  } finally {
    await Deno.remove(base, { recursive: true });
  }
});
