// SPDX-License-Identifier: LGPL-3.0-only
import { basename, dirname, isAbsolute, join, resolve } from "@std/path";
import type { ProjectIdentityFact, ProjectSeed } from "./types.ts";

type Repository = NonNullable<ProjectIdentityFact["repository"]>;
/**
 * Reads local Git evidence for native checkouts; never writes or prunes Git.
 * A present checkout's repository comes from its own `.git`. A removed one is
 * recovered from its repository's retained worktree registration, else from
 * the `<repo>.<name>` naming of exactly one discovered repository.
 */
export class CheckoutRepositories {
  #repositories = new Set<string>();
  #registered = new Map<string, string>();
  #lookups = new Map<string, Promise<Repository | undefined>>();
  private constructor() {}
  static async discover(
    roots: readonly string[],
  ): Promise<CheckoutRepositories> {
    const owner = new CheckoutRepositories();
    const commons = new Map<string, string>();
    for (const root of new Set(roots)) {
      if (!isAbsolute(root)) continue;
      const git = await gitRepository(root);
      if (git) commons.set(git.common, git.root);
    }
    for (const [common, root] of commons) {
      owner.#repositories.add(root);
      // Git keeps a registration after a manual directory removal, until pruning.
      try {
        for await (const row of Deno.readDir(join(common, "worktrees"))) {
          if (!row.isDirectory) continue;
          const file = join(common, "worktrees", row.name, "gitdir");
          let gitdir: string;
          try {
            gitdir = (await Deno.readTextFile(file)).trim();
          } catch (error) {
            if (error instanceof Deno.errors.NotFound) continue;
            throw error;
          }
          owner.#registered.set(dirname(resolve(dirname(file), gitdir)), root);
        }
      } catch (error) {
        if (!(error instanceof Deno.errors.NotFound)) throw error;
      }
    }
    return owner;
  }
  async #resolve(checkout: string): Promise<Repository | undefined> {
    const git = await gitRepository(checkout);
    if (git) {
      return { checkout, root: git.root, present: true, evidence: "git" };
    }
    try {
      await Deno.stat(checkout);
      // An existing non-Git scope keeps its native contract.
      return;
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) throw error;
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
    const named = [...this.#repositories].filter((root) =>
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
): Promise<{ root: string; common: string } | undefined> {
  const marker = join(directory, ".git");
  try {
    if ((await Deno.stat(marker)).isDirectory) {
      return { root: directory, common: marker };
    }
    const text = (await Deno.readTextFile(marker)).trim();
    if (!text.startsWith("gitdir: ")) return;
    const gitdir = resolve(directory, text.slice(8));
    let common = gitdir;
    try {
      common = resolve(
        gitdir,
        (await Deno.readTextFile(join(gitdir, "commondir"))).trim(),
      );
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) throw error;
    }
    // A submodule's gitdir has no commondir; the checkout is its own root.
    return {
      root: basename(common) === ".git" ? dirname(common) : directory,
      common,
    };
  } catch (error) {
    if (
      error instanceof Deno.errors.NotFound ||
      error instanceof Deno.errors.NotADirectory
    ) return;
    throw error;
  }
}
