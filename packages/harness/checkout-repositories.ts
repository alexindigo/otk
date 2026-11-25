// SPDX-License-Identifier: LGPL-3.0-only
import { basename, dirname, isAbsolute, join, resolve } from "@std/path";
import type { ProjectIdentityFact, ProjectSeed } from "./types.ts";

type Repository = NonNullable<ProjectIdentityFact["repository"]>;
type GitDirectory = { common: string; linked: boolean };
/**
 * Reads local Git evidence for native checkouts; never writes or prunes Git.
 * A present checkout's repository comes from its own `.git`. A removed one is
 * recovered from its repository's retained worktree registration, else from
 * the `<repo>.<name>` naming of exactly one discovered repository.
 */
export class CheckoutRepositories {
  #mainByCommon = new Map<string, string>();
  #registered = new Map<string, string>();
  #lookups = new Map<string, Promise<Repository | undefined>>();
  private constructor() {}
  static async discover(
    roots: readonly string[],
  ): Promise<CheckoutRepositories> {
    const owner = new CheckoutRepositories();
    const commons = new Set<string>();
    for (const root of new Set(roots)) {
      if (!isAbsolute(root)) continue;
      const git = await gitRepository(root);
      if (!git) continue;
      commons.add(git.common);
      if (!git.linked) owner.#mainByCommon.set(git.common, root);
    }
    for (const common of commons) {
      const root = await owner.#mainDirectory(common);
      if (!root) continue;
      owner.#mainByCommon.set(common, root);
      // Git keeps a registration after a manual directory removal, until pruning.
      try {
        for await (const row of Deno.readDir(join(common, "worktrees"))) {
          if (!row.isDirectory) continue;
          const file = join(common, "worktrees", row.name, "gitdir");
          const gitdir = await Deno.readTextFile(file).catch(() => undefined);
          if (!gitdir?.trim()) continue;
          owner.#registered.set(
            dirname(resolve(dirname(file), gitdir.trim())),
            root,
          );
        }
      } catch {
        // The registration inventory is supplementary; keep the facts read so far.
      }
    }
    return owner;
  }
  async #mainDirectory(common: string): Promise<string | undefined> {
    const known = this.#mainByCommon.get(common);
    if (known) return known;
    // The native inventory can name only linked worktrees. Recover an adjacent
    // main checkout only if its own marker proves it owns this Git directory.
    const candidate = dirname(common);
    const git = await gitRepository(candidate);
    if (git?.common === common && !git.linked) return candidate;
  }
  async #resolve(checkout: string): Promise<Repository | undefined> {
    const git = await gitRepository(checkout);
    if (git) {
      const root = git.linked
        ? await this.#mainDirectory(git.common)
        : checkout;
      // A linked checkout's marker alone cannot locate a separately stored main
      // checkout. In that case leave the native evidence intact.
      return root
        ? { checkout, root, present: true, evidence: "git" }
        : undefined;
    }
    try {
      await Deno.stat(checkout);
      // An existing non-Git scope keeps its native contract.
      return;
    } catch (error) {
      // An inaccessible checkout is not evidence of removal.
      if (!(error instanceof Deno.errors.NotFound)) return;
    }
    const registered = this.#registered.get(checkout);
    if (registered) {
      return {
        checkout,
        root: registered,
        present: false,
        evidence: "worktree-metadata",
      };
    }
    const named = [...new Set(this.#mainByCommon.values())].filter((root) =>
      dirname(root) === dirname(checkout) &&
      basename(checkout).startsWith(basename(root) + ".") &&
      basename(checkout).length > basename(root).length + 1
    );
    // Ambiguous naming names no repository rather than the first prefix seen.
    return named.length === 1
      ? { checkout, root: named[0], present: false, evidence: "name" }
      : { checkout, root: null, present: false, evidence: "none" };
  }
  /** Adds evidence to repository-affiliated facts; other facts are unchanged. */
  async seeds(
    rows: readonly ProjectSeed[],
    signal: AbortSignal,
  ): Promise<ProjectSeed[]> {
    const result: ProjectSeed[] = [];
    for (const row of rows) {
      signal.throwIfAborted();
      if (!row.identities) {
        result.push(row);
        continue;
      }
      const identities: ProjectIdentityFact[] = [];
      for (const fact of row.identities) {
        const checkout = fact.recordedRoot ?? row.directory;
        if (!fact.canonicalRoot || !isAbsolute(checkout)) {
          identities.push(fact);
          continue;
        }
        let lookup = this.#lookups.get(checkout);
        if (!lookup) {
          this.#lookups.set(checkout, lookup = this.#resolve(checkout));
        }
        const repository = await lookup;
        identities.push(repository ? { ...fact, repository } : fact);
      }
      result.push({ ...row, identities });
    }
    signal.throwIfAborted();
    return result;
  }
}

async function gitRepository(
  directory: string,
): Promise<GitDirectory | undefined> {
  const marker = join(directory, ".git");
  try {
    if ((await Deno.stat(marker)).isDirectory) {
      return { common: await Deno.realPath(marker), linked: false };
    }
    const text = (await Deno.readTextFile(marker)).trim();
    if (!text.startsWith("gitdir: ")) return;
    const gitdir = resolve(directory, text.slice(8));
    let common: string;
    try {
      common = (await Deno.readTextFile(join(gitdir, "commondir"))).trim();
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) throw error;
      // A submodule or a main checkout with --separate-git-dir has no commondir.
      return { common: await Deno.realPath(gitdir), linked: false };
    }
    if (common) {
      return {
        common: await Deno.realPath(resolve(gitdir, common)),
        linked: true,
      };
    }
  } catch {
    // Failure to read supplementary Git evidence must not block native inventory.
    return;
  }
}
