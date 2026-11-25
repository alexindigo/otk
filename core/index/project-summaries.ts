// SPDX-License-Identifier: LGPL-3.0-only
import {
  type IndexMetadata,
  type ProjectSummary,
  type ProjectTopology,
  UNKNOWN_REPOSITORY,
} from "@otk/protocol";
import { SessionSupervision } from "./supervision.ts";
import { EntityStates } from "./entity-states.ts";
import { type IdentityChange, ProjectIdentity } from "./project-identity.ts";
import type { SessionHierarchy } from "./session-hierarchy.ts";

/** Scalar, keyed project owner. It never reads native APIs, digests or usage. */
export class ProjectSummaries {
  readonly values = new Map<string, ProjectSummary>();
  #sessions = new Map<string, { entry: IndexMetadata; leaf: string }>();
  #repoSessions = new Map<string, Set<string>>();
  #projects = new Map<string, Map<string, IndexMetadata>>();
  /** Inventory facts only; attention is read from the entity-state owner. */
  #facts = new Map<string, { time: number }>();
  #totals = new Map<
    string,
    {
      count: number;
      times: Map<number, number>;
      last: number;
    }
  >();
  #locationForms: Readonly<Record<string, number>> = {};
  #terminalScopes: ReadonlyMap<string, number> = new Map();
  #terminalCounts = new Map<string, number>();
  terminalDependencies(values: ReadonlyMap<string, number>): void {
    this.#terminalScopes = values;
    const dirty = this.#reconcileTerminals();
    this.#flush(dirty);
    this.retain(this.#known);
  }
  #reconcileTerminals(): Set<string> {
    const next = new Map<string, number>();
    for (const [scope, count] of this.#terminalScopes) {
      const leaf = this.leaf(scope);
      next.set(leaf, (next.get(leaf) ?? 0) + count);
    }
    const dirty = new Set([...this.#terminalCounts.keys(), ...next.keys()]);
    this.#terminalCounts = next;
    return dirty;
  }
  locationForms(values: Readonly<Record<string, number>>): void {
    const affected = new Set([
      ...Object.keys(this.#locationForms),
      ...Object.keys(values),
    ]);
    this.#locationForms = { ...values };
    for (const directory of affected) {
      this.ensure(directory);
      this.#update(directory);
    }
  }
  #authority: ProjectSummary["authority"] = "unknown";
  #catalog = false;
  #known = new Set<string>();
  #retained = new Set<string>();
  #seeds = new Map<string, import("@otk/harness").ProjectSeed>();
  #leafSeeds = new Map<
    string,
    Map<string, import("@otk/harness").ProjectSeed>
  >();
  #seeded = false;
  #topology = new Map<string, ProjectTopology>();
  #leaves = new Map<string, Set<string>>();
  #direct = new Map<string, ProjectSummary>();
  /** Repository and checkout ownership belongs exclusively to ProjectIdentity. */
  leaf(directory: string, repoID?: string): string {
    return this.hierarchy?.project(directory, repoID) ??
      this.identity.leaf(directory, repoID);
  }
  context(directory: string): string | undefined {
    return this.#topology.get(directory)?.parentDirectory;
  }
  seed(
    values: readonly import("@otk/harness").ProjectSeed[],
  ): readonly IndexMetadata[] {
    const dirty = new Set(values.map((value) => this.leaf(value.directory)));
    const change = this.identity.learn(values);
    this.#seeded = true;
    for (const value of values) {
      this.#seeds.set(value.directory, {
        ...value,
        hasSessions: value.hasSessions ??
          this.#seeds.get(value.directory)?.hasSessions,
      });
    }
    const affected = this.#reconcile(change, dirty);
    for (const seed of values) dirty.add(this.leaf(seed.directory));
    this.#flush(dirty);
    this.retain(this.#known);
    return affected;
  }
  /** Both native seeds and recorded roots revise the same shared projection. */
  #reconcile(change: IdentityChange, dirty: Set<string>): IndexMetadata[] {
    for (const directory of change.directories) dirty.add(directory);
    const affected = new Set(
      [...change.repos].flatMap((
        repo,
      ) => [...this.#repoSessions.get(repo) ?? []]),
    );
    for (const id of affected) {
      const row = this.#sessions.get(id)!;
      const leaf = this.leaf(row.entry.directory, row.entry.projectID);
      if (leaf === row.leaf) continue;
      this.#contribute(row.entry, -1, row.leaf);
      this.#projects.get(row.leaf)?.delete(id);
      dirty.add(row.leaf);
      row.leaf = leaf;
      this.states.member(id, leaf);
      const entries = this.#projects.get(leaf) ?? new Map();
      entries.set(id, row.entry);
      this.#projects.set(leaf, entries);
      this.#contribute(row.entry, 1, leaf);
      dirty.add(leaf);
    }
    for (const [leaf, seeds] of this.#leafSeeds) {
      for (const scope of seeds.keys()) {
        const next = this.leaf(scope);
        if (next !== leaf) {
          dirty.add(leaf);
          dirty.add(next);
        }
      }
    }
    this.#topology.clear();
    for (const topology of this.identity.topologies()) {
      this.#topology.set(topology.leafDirectory, topology);
    }
    this.#leafSeeds.clear();
    for (const seed of this.#seeds.values()) {
      const directory = this.leaf(seed.directory);
      const seeds = this.#leafSeeds.get(directory) ?? new Map();
      seeds.set(seed.directory, seed);
      this.#leafSeeds.set(directory, seeds);
    }
    this.#leaves.clear();
    for (const topology of this.#topology.values()) {
      const leaves = this.#leaves.get(topology.canonicalRoot) ?? new Set();
      leaves.add(topology.leafDirectory);
      this.#leaves.set(topology.canonicalRoot, leaves);
      // An unknown repository is a placement, never a fabricated project row.
      if (
        topology.canonicalRoot !== UNKNOWN_REPOSITORY &&
        !this.#topology.has(topology.canonicalRoot)
      ) {
        this.#topology.set(topology.canonicalRoot, {
          ...topology,
          leafDirectory: topology.canonicalRoot,
          parentDirectory: undefined,
        });
      }
    }
    this.#retained = new Set(
      [...this.#known].map((directory) => this.leaf(directory)),
    );
    for (const directory of this.#reconcileTerminals()) dirty.add(directory);
    return [...affected].map((id) => this.#sessions.get(id)!.entry);
  }
  #flush(dirty: Set<string>): void {
    for (const directory of dirty) {
      const parent = this.#topology.get(directory)?.parentDirectory;
      if (parent) dirty.add(parent);
    }
    for (const directory of dirty) {
      if (!this.#projects.has(directory)) {
        this.#projects.set(directory, new Map());
      }
      this.#update(directory, false);
    }
    for (const directory of dirty) this.#publish(directory);
  }
  /** Status and unseen counts belong to this owner; summaries place members. */
  readonly states: EntityStates;
  constructor(
    readonly marks: (id: string) => { seen: number; finish: number },
    readonly publish: (summary: ProjectSummary) => void,
    readonly retire: (directory: string) => void = () => {},
    readonly supervision = new SessionSupervision(),
    readonly identity = new ProjectIdentity(),
    readonly hierarchy?: SessionHierarchy,
    states?: EntityStates,
    clock?: EntityStates["clock"],
  ) {
    // Standalone summaries own a private, unpublished entity-state owner.
    this.states = states ?? new EntityStates(
      supervision,
      {
        getMetadata: (id) => this.#sessions.get(id)?.entry,
        ancestors: () => [],
        descendants: (id) => new Set([id]),
      },
      () => {},
      clock,
    );
  }
  ensure(directory: string): void {
    this.#known.add(directory);
    directory = this.leaf(directory);
    this.#retained.add(directory);
    if (!this.#projects.has(directory)) {
      this.#projects.set(directory, new Map());
    }
    if (!this.values.has(directory)) this.#update(directory);
  }
  retain(directories: Iterable<string>): void {
    this.#known = new Set(directories);
    this.#retained = new Set(
      [...this.#known].map((directory) => this.leaf(directory)),
    );
    for (const directory of this.#known) this.ensure(directory);
    for (const [directory, entries] of this.#projects) {
      if (
        entries.size || this.#retained.has(directory) ||
        this.#leafSeeds.has(directory) || this.#leaves.has(directory) ||
        this.#locationForms[directory] || this.#terminalCounts.get(directory)
      ) {
        this.#publish(directory);
        continue;
      }
      this.#projects.delete(directory);
      this.#totals.delete(directory);
      this.#direct.delete(directory);
      this.values.delete(directory);
      this.states.drop(directory);
      this.retire(directory);
    }
  }
  authority(value: ProjectSummary["authority"]): void {
    this.#authority = value;
    this.supervision.freshness(value !== "stale");
    if (value !== "stale") this.#catalog = true;
    this.refresh();
  }
  entry(entry: IndexMetadata): readonly IndexMetadata[] {
    const before = this.#sessions.get(entry.id);
    if (JSON.stringify(before?.entry) === JSON.stringify(entry)) return [];
    const change = this.identity.remember(
      entry.directory,
      entry.projectID,
      entry.checkoutRoot,
    );
    if (before) {
      this.#repoSessions.get(before.entry.projectID)?.delete(entry.id);
      this.#contribute(before.entry, -1, before.leaf);
      this.#projects.get(before.leaf)?.delete(
        entry.id,
      );
    }
    const directory = this.leaf(entry.directory, entry.projectID);
    this.#sessions.set(entry.id, { entry, leaf: directory });
    this.states.member(entry.id, directory);
    const repo = this.#repoSessions.get(entry.projectID) ?? new Set();
    repo.add(entry.id);
    this.#repoSessions.set(entry.projectID, repo);
    const project = this.#projects.get(directory) ?? new Map();
    project.set(entry.id, entry);
    this.#projects.set(directory, project);
    this.#contribute(entry, 1, directory);
    const dirty = new Set([directory, ...before ? [before.leaf] : []]);
    const affected = change.repos.size ? this.#reconcile(change, dirty) : [];
    this.#flush(dirty);
    if (change.repos.size) this.retain(this.#known);
    return affected;
  }
  remove(id: string): void {
    const before = this.#sessions.get(id);
    if (!before) return;
    this.#contribute(before.entry, -1, before.leaf);
    this.#sessions.delete(id);
    this.states.member(id);
    this.states.remove(id);
    this.#repoSessions.get(before.entry.projectID)?.delete(id);
    const directory = before.leaf;
    this.#projects.get(directory)?.delete(id);
    this.#update(directory);
    this.retain(this.#known);
  }
  mark(id: string): void {
    const row = this.#sessions.get(id);
    if (row) {
      this.#contribute(row.entry, -1, row.leaf);
      this.#contribute(row.entry, 1, row.leaf);
      this.#update(row.leaf);
    }
  }
  /** Re-read one directory's attention from the owner. */
  touch(directory: string): void {
    const leaf = this.leaf(directory);
    if (this.#projects.has(leaf)) this.#update(leaf);
  }
  permissions(lookup: (id: string) => number): void {
    this.supervision.permissions(lookup);
    this.refresh();
  }
  refresh(): void {
    for (const row of this.#sessions.values()) {
      this.#contribute(row.entry, -1, row.leaf);
      this.#contribute(row.entry, 1, row.leaf);
    }
    for (const directory of this.#projects.keys()) this.#update(directory);
  }
  #contribute(entry: IndexMetadata, sign: 1 | -1, directory: string): void {
    if (sign > 0) {
      // The owner interprets the session once; this summary reads its state.
      const marks = this.marks(entry.id);
      this.states.session(entry, marks.seen, marks.finish);
    }
    if (entry.deleted) return;
    let totals = this.#totals.get(directory);
    if (!totals) {
      totals = { count: 0, times: new Map(), last: 0 };
      this.#totals.set(directory, totals);
    }
    const fact = sign === -1
      ? this.#facts.get(entry.id)!
      : { time: entry.timeUpdated };
    if (!fact) return;
    totals.count += sign;
    const count = (totals.times.get(fact.time) ?? 0) + sign;
    if (count) totals.times.set(fact.time, count);
    else totals.times.delete(fact.time);
    if (sign > 0) {
      totals.last = Math.max(totals.last, fact.time);
      this.#facts.set(entry.id, fact);
    } else {
      if (fact.time === totals.last && !count) {
        totals.last = 0;
        for (const time of totals.times.keys()) {
          totals.last = Math.max(totals.last, time);
        }
      }
      this.#facts.delete(entry.id);
    }
  }
  #update(directory: string, publish = true): void {
    const topology = this.identity.topology(directory);
    if (topology) {
      this.#topology.set(directory, topology);
      const leaves = this.#leaves.get(topology.canonicalRoot) ??
        new Set<string>();
      leaves.add(directory);
      this.#leaves.set(topology.canonicalRoot, leaves);
      if (
        topology.parentDirectory && !this.#projects.has(topology.canonicalRoot)
      ) {
        this.#topology.set(topology.canonicalRoot, {
          ...topology,
          leafDirectory: topology.canonicalRoot,
          parentDirectory: undefined,
        });
        this.#projects.set(topology.canonicalRoot, new Map());
        this.#update(topology.canonicalRoot, publish);
      }
    }
    const entries = this.#projects.get(directory)!;
    const totals = this.#totals.get(directory);
    const previous = this.values.get(directory);
    const locationForms = this.#locationForms[directory] ?? 0;
    const checkout = this.states.checkout(
      directory,
      locationForms,
      this.#terminalCounts.get(directory),
    );
    const count = totals?.count ?? 0,
      unseen = checkout.counts.unseen,
      last = totals?.last ?? 0;
    const authority = this.#authority === "stale"
      ? previous?.authority === "unknown" ? "unknown" : "stale"
      : locationForms
      ? "current"
      : entries.size
      ? "current"
      : this.#authority;
    const status = checkout.state;
    const knownCount = this.#catalog;
    const seeds = [...this.#leafSeeds.get(directory)?.values() ?? []];
    const seed = seeds.length
      ? {
        hasSessions: seeds.some((s) => s.hasSessions === true)
          ? true
          : seeds.every((s) => s.hasSessions === false)
          ? false
          : undefined,
        sessionCount: seeds.every((s) => s.sessionCount !== null)
          ? seeds.reduce((n, s) => n + s.sessionCount!, 0)
          : null,
        lastActivity:
          seeds.every((s) => s.lastActivity !== null || s.hasSessions === false)
            ? Math.max(0, ...seeds.map((s) => s.lastActivity ?? 0))
            : null,
      }
      : undefined;
    const summary: ProjectSummary = {
      directory,
      ...(seeds.length &&
          seeds.every((seed) =>
            seed.presentation?.id === seeds[0].presentation?.id
          ) &&
          seeds[0].presentation
        ? { presentation: seeds[0].presentation }
        : {}),
      ...(this.identity.availability(directory)
        ? {
          availability: this.identity.availability(directory),
          archived: this.identity.archived(directory),
          memberships: this.identity.memberships(directory),
        }
        : {}),
      ...(locationForms ? { locationForms } : {}),
      ...(checkout.dependencies ? { dependencies: checkout.dependencies } : {}),
      hasSessions: count > 0 ? true : seed ? seed.hasSessions : false,
      status,
      sessionCount: seed
        ? seed.sessionCount
        : knownCount && !this.#seeded
        ? count
        : null,
      unseenCount: seed || knownCount ? unseen : null,
      lastActivity: seed
        ? seed.lastActivity === null && !last
          ? null
          : Math.max(seed.lastActivity ?? 0, last)
        : knownCount && !this.#seeded
        ? last
        : null,
      authority,
      ...(this.#topology.has(directory) ||
          this.identity.memberships(directory).length
        ? {
          topology: this.#topology.get(directory),
          scopes: [
            ...new Set([
              directory,
              ...seeds.map((s) => s.directory),
              ...[...entries.values()].map((e) => e.directory),
            ]),
          ].sort(),
        }
        : {}),
    };
    this.#direct.set(directory, summary);
    this.states.placement(summary);
    if (!publish) return;
    this.#publish(directory);
    const parent = summary.topology?.parentDirectory;
    if (parent) this.#publish(parent);
  }
  #publish(directory: string): void {
    const direct = this.#direct.get(directory);
    if (!direct) return;
    const leaves = this.#leaves.get(directory);
    const summaries = leaves &&
      [...leaves].map((leaf) => this.#direct.get(leaf)).filter((
        s,
      ): s is ProjectSummary => !!s);
    const project = this.states.project(
      directory,
      summaries?.length ? summaries.map((s) => s.directory) : [directory],
    );
    const summary: ProjectSummary = summaries?.length
      ? {
        ...direct,
        direct,
        ...(project.dependencies ? { dependencies: project.dependencies } : {}),
        ...(summaries.some((s) => s.locationForms)
          ? {
            locationForms: summaries.reduce(
              (n, s) => n + (s.locationForms ?? 0),
              0,
            ),
          }
          : {}),
        hasSessions: summaries.some((s) => s.hasSessions === true)
          ? true
          : summaries.every((s) => s.hasSessions === false)
          ? false
          : undefined,
        sessionCount: summaries.every((s) => s.sessionCount !== null)
          ? summaries.reduce((n, s) => n + s.sessionCount!, 0)
          : null,
        unseenCount: summaries.every((s) => s.unseenCount !== null)
          ? project.counts.unseen
          : null,
        lastActivity: summaries.every((s) => s.lastActivity !== null)
          ? Math.max(...summaries.map((s) => s.lastActivity!))
          : null,
        status: project.state,
        authority: summaries.some((s) => s.authority === "unknown")
          ? "unknown"
          : summaries.some((s) => s.authority === "stale")
          ? "stale"
          : "current",
      }
      : direct;
    // Inventory topology is retained independently of row materialization.
    // Empty untracked checkouts are not fabricated projects on the wire.
    if (
      this.#seeded && summary.hasSessions === false &&
      !summary.locationForms &&
      !summary.dependencies &&
      !this.#retained.has(directory) &&
      !this.#projects.get(directory)?.size
    ) {
      if (this.values.delete(directory)) {
        this.states.drop(directory);
        this.retire(directory);
      }
      return;
    }
    if (
      JSON.stringify(summary) === JSON.stringify(this.values.get(directory))
    ) return;
    this.values.set(directory, summary);
    this.publish(summary);
  }
}
