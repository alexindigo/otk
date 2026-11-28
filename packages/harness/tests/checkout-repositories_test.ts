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

Deno.test("an unreadable Git marker or registration does not discard native inventory or other Git evidence", async () => {
  const base = await Deno.makeTempDir();
  const blocked = join(base, "blocked");
  const marker = join(blocked, ".git");
  try {
    const repo = await layout(base);
    const invalid = join(repo, ".git", "worktrees", "00-bad", "gitdir");
    await Deno.mkdir(invalid, { recursive: true });
    await Deno.mkdir(blocked);
    await Deno.writeTextFile(marker, "gitdir: unavailable\n", { mode: 0 });
    const owner = await CheckoutRepositories.discover([blocked, repo]);
    const unavailable = seed(blocked, blocked);
    const removed = join(base, "repo.removed");
    const [unchanged, healthy] = await owner.seeds(
      [unavailable, seed(removed, removed)],
      new AbortController().signal,
    );
    assertEquals(unchanged, unavailable);
    assertEquals(healthy.identities![0].repository, {
      checkout: removed,
      root: repo,
      present: false,
      evidence: "worktree-metadata",
    });
  } finally {
    await Deno.remove(base, { recursive: true });
  }
});

Deno.test("a separate Git directory's main checkout owns its linked and removed worktrees", async () => {
  const base = await Deno.makeTempDir();
  try {
    const repo = await layout(base);
    const name = "not-a-dot-git-directory";
    const common = join(base, name);
    await Deno.rename(join(repo, ".git"), common);
    await Deno.writeTextFile(join(repo, ".git"), `gitdir: ../${name}\n`);
    const live = join(base, "repo.live");
    const removed = join(base, "repo.removed");
    await Deno.writeTextFile(
      join(live, ".git"),
      `gitdir: ${join(common, "worktrees", "repo.live")}\n`,
    );
    for (const roots of [[repo, live], [live, repo]]) {
      const owner = await CheckoutRepositories.discover(roots);
      const rows = await owner.seeds(
        [repo, live, removed].map((path) => seed(path, path)),
        new AbortController().signal,
      );
      assertEquals(rows.map((row) => row.identities![0].repository?.root), [
        repo,
        repo,
        repo,
      ]);
      assertEquals(
        rows[2].identities![0].repository?.evidence,
        "worktree-metadata",
      );
    }
  } finally {
    await Deno.remove(base, { recursive: true });
  }
});

Deno.test("checkout evidence keeps only the chosen effective remote and distinguishes failed reads", async () => {
  const base = await Deno.makeTempDir();
  const signal = AbortSignal.timeout(15_000);
  const Command = Deno.Command;
  const at = (name: string) => join(base, name);
  const git = async (directory: string, ...args: string[]) => {
    const result = await new Deno.Command("git", {
      args: ["-C", directory, ...args],
      signal,
      stdout: "null",
      stderr: "null",
    }).output();
    assertEquals(result.code, 0, args.join(" "));
  };
  try {
    for (const name of ["main", "none", "ambiguous", "unreadable", "rewrite"]) {
      await git(base, "init", at(name));
    }
    await git(
      at("main"),
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.test",
      "commit",
      "--allow-empty",
      "-m",
      "seed",
    );
    await git(base, "clone", at("main"), at("clone"));
    await git(at("clone"), "worktree", "add", "--detach", at("linked"));
    await git(
      at("main"),
      "remote",
      "add",
      "origin",
      "ssh://git@unreachable.invalid/Case/Repo.git",
    );
    await git(
      at("main"),
      "remote",
      "add",
      "upstream",
      "ssh://git@other.invalid/Repo.git",
    );
    await git(
      at("clone"),
      "remote",
      "set-url",
      "origin",
      "https://unreachable.invalid/Case/Repo",
    );
    for (const name of ["one", "two"]) {
      await git(
        at("ambiguous"),
        "remote",
        "add",
        name,
        `ssh://git@other.invalid/${name}.git`,
      );
    }
    await git(
      at("rewrite"),
      "config",
      "url.https://user:ignored@github.com/Org/.insteadOf",
      "project:",
    );
    await git(at("rewrite"), "remote", "add", "single", "project:Repo.git");
    await Deno.chmod(join(at("unreadable"), ".git", "config"), 0);
    const paths = [
      "main",
      "clone",
      "linked",
      "none",
      "ambiguous",
      "unreadable",
      "rewrite",
    ].map(at);
    const owner = await CheckoutRepositories.discover(paths);
    const calls: ConstructorParameters<typeof Deno.Command>[] = [];
    Deno.Command = new Proxy(Command, {
      construct(target, args: ConstructorParameters<typeof Deno.Command>) {
        calls.push(args);
        return new target(...args);
      },
    });
    const rows = await owner.seeds(
      paths.map((path) => seed(path, path)),
      signal,
    );
    const shared = { key: "unreachable.invalid/Case/Repo" };
    assertEquals(rows.map((r) => r.identities?.[0].repository?.remote), [
      shared,
      shared,
      shared,
      null,
      null,
      undefined,
      { key: "github.com/org/repo", owner: "org" },
    ]);
    const cloneCalls = calls.filter((args) =>
      args[1]?.args?.[1] === at("clone")
    );
    assertEquals(cloneCalls.length, 2);
    for (const args of calls) {
      assertEquals(args[0], "git");
      assertEquals(args[1]?.env?.GIT_TERMINAL_PROMPT, "0");
      assertEquals(args[1]?.env?.GIT_OPTIONAL_LOCKS, "0");
    }
  } finally {
    Deno.Command = Command;
    await Deno.remove(base, { recursive: true });
  }
});
