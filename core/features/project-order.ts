// SPDX-License-Identifier: LGPL-3.0-only
import {
  type ProjectMove,
  type ProjectOrderFrame,
  UNKNOWN_REPOSITORY,
} from "@otk/protocol";
import type { ProjectOrderStore, StoreWrite } from "@otk/store";
import type { ProjectIdentity } from "../index/project-identity.ts";

/** The only owner of project rank; checkout topology remains native evidence. */
export class ProjectOrder {
  #revision = 1;
  #frames = new Map<string, ProjectOrderFrame>();
  #listeners = new Set<(user: string) => void>();
  #seeded = new Set<string>();
  #admitted = new Map<string, Set<string>>();
  #stop: () => void;
  constructor(
    readonly store: ProjectOrderStore,
    readonly identity:
      & Pick<ProjectIdentity, "topology" | "memberships">
      & Partial<
        Pick<
          ProjectIdentity,
          "grouped" | "successor" | "separates" | "compatibleRemote"
        >
      >,
  ) {
    this.#stop = store.listen(({ user }) => {
      this.#revision++;
      this.#frames.delete(user);
      this.#admitted.delete(user);
      for (const listener of this.#listeners) listener(user);
    });
  }
  get revision(): number {
    return this.#revision;
  }
  listen(listener: (user: string) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }
  close(): void {
    this.#stop();
    this.#listeners.clear();
  }
  frame(user: string): ProjectOrderFrame {
    let frame = this.#frames.get(user);
    if (frame?.revision !== this.revision) {
      frame = {
        t: "projects.order",
        revision: this.revision,
        projects: this.store.list(user).map(({ id, directories }) => ({
          id,
          directories,
        })),
      };
      this.#frames.set(user, frame);
    }
    return frame;
  }
  move(user: string, params: ProjectMove, tx?: StoreWrite): void {
    this.store.move(user, params.id, params, tx);
  }
  admit(
    user: string,
    directories: Iterable<string>,
    revised: Iterable<string> = [],
  ): void {
    let admitted = this.#admitted.get(user);
    if (!admitted) {
      admitted = new Set(
        this.store.list(user).flatMap((row) => row.directories),
      );
      this.#admitted.set(user, admitted);
    }
    const legacy = this.#seeded.has(user) ? [] : this.store.legacy(user);
    const added = [...new Set(directories)].filter((dir) => !admitted.has(dir))
      .sort();
    // Recover a committed identity upgrade even if the process died before
    // its order transaction. Normal startup does not reconcile former roots.
    const recovered = this.#seeded.has(user)
      ? []
      : [...admitted].filter((d) => this.identity.grouped?.(d));
    const updates = [...new Set([...recovered, ...revised])].filter((dir) =>
      admitted.has(dir) && this.identity.topology(dir)
    ).sort();
    if (!legacy.length && !added.length && !updates.length) {
      this.#seeded.add(user);
      return;
    }
    this.store.db.write((tx) => {
      for (const { directory } of legacy) this.#resolve(user, directory, tx);
      if (legacy.length) this.store.dropLegacy(user, tx);
      // First give an existing ID its new root. A departing former anchor can
      // then split without moving the surviving group's saved slot.
      for (const directory of updates) {
        const root = this.identity.successor?.(directory) ??
          this.identity.topology(directory)?.canonicalRoot;
        const id = this.store.alias(user, directory);
        if (
          !root || root === directory || root === UNKNOWN_REPOSITORY ||
          !id || this.store.alias(user, root) !== id
        ) continue;
        if (
          this.store.list(user).find((p) => p.id === id)?.root !== directory
        ) continue;
        this.store.reroot(
          user,
          id,
          root,
          tx,
          this.identity.topology(root)?.repoID,
        );
      }
      for (const directory of updates) {
        const topology = this.identity.topology(directory);
        const id = this.store.alias(user, directory);
        if (
          topology?.canonicalRoot === directory && id
        ) {
          const previous = this.store.list(user).find((p) => p.id === id)!;
          if (
            previous.root !== directory &&
            this.identity.separates?.(directory, previous.root)
          ) {
            const newID = this.store.split(
              user,
              directory,
              id,
              tx,
              topology.repoID,
            );
            for (const alias of previous.directories) {
              if (
                alias !== directory &&
                this.identity.topology(alias)?.canonicalRoot === directory
              ) {
                this.store.attach(user, alias, newID, tx);
              }
            }
          } else {
            this.store.rememberRepository(user, directory, topology.repoID, tx);
          }
        }
      }
      // Move former roots first so their whole alias list moves in saved order.
      const roots = new Set(this.store.list(user).map((p) => p.root));
      for (const directory of updates) {
        if (roots.has(directory)) this.#reparent(user, directory, tx);
      }
      for (const directory of updates) this.#reparent(user, directory, tx);
      for (const directory of added) this.#resolve(user, directory, tx);
    });
    this.#admitted.set(
      user,
      new Set(this.store.list(user).flatMap((row) => row.directories)),
    );
    this.#seeded.add(user);
  }
  #resolve(
    user: string,
    directory: string,
    tx: StoreWrite,
    parents = new Set<string>(),
  ): string {
    const known = this.store.alias(user, directory);
    if (known) return known;
    const topology = this.identity.topology(directory);
    const root = topology?.canonicalRoot;
    if (
      root && root !== UNKNOWN_REPOSITORY && root !== directory &&
      !parents.has(root)
    ) {
      parents.add(directory);
      const id = this.#resolve(user, root, tx, parents);
      this.store.attach(user, directory, id, tx);
      return id;
    }
    const repo = root === directory ? topology?.repoID : undefined;
    if (repo) {
      const retired = this.store.list(user).filter((candidate) => {
        if (candidate.repo !== repo) return false;
        if (
          this.identity.compatibleRemote?.(directory, candidate.root) === false
        ) {
          return false;
        }
        const memberships = this.identity.memberships(candidate.root);
        return memberships.length > 0 &&
          memberships.every((member) =>
            member.inventory === "current" && member.availability !== "present"
          );
      });
      if (retired.length === 1) {
        const id = retired[0].id;
        this.store.attach(user, directory, id, tx);
        this.store.reroot(user, id, directory, tx);
        return id;
      }
    }
    return this.store.create(user, directory, repo, tx);
  }
  #reparent(user: string, directory: string, tx: StoreWrite): void {
    const id = this.store.alias(user, directory);
    if (!id) return;
    const root = this.identity.topology(directory)?.canonicalRoot;
    if (!root || root === UNKNOWN_REPOSITORY || root === directory) return;
    const before = this.store.list(user).find((project) => project.id === id)!;
    if (before.root === root) return;
    const target = this.#resolve(user, root, tx);
    if (id === target) return;
    for (
      const alias of before.root === directory
        ? before.directories
        : [directory]
    ) {
      // Positive evidence can redirect a former child elsewhere in the same
      // revision; only unknown or matching aliases follow the retiring root.
      const canonical = this.identity.topology(alias)?.canonicalRoot;
      if (canonical && canonical !== UNKNOWN_REPOSITORY && canonical !== root) {
        continue;
      }
      this.store.attach(user, alias, target, tx);
    }
  }
}
