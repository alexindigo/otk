// SPDX-License-Identifier: LGPL-3.0-only
import {
  type IndexMetadata,
  PROJECT_STATUS_PRIORITY,
  type ProjectStatus,
  type ProjectSummary,
  type ProjectTopology,
} from "@otk/protocol";
import { SessionSupervision } from "./supervision.ts";

/** Scalar, keyed project owner. It never reads native APIs, digests or usage. */
export class ProjectSummaries {
  readonly values = new Map<string, ProjectSummary>();
  #sessions = new Map<string, IndexMetadata>();
  #repoSessions = new Map<string, Set<string>>();
  #projects = new Map<string, Map<string, IndexMetadata>>();
  #facts = new Map<
    string,
    { status: ProjectStatus; unseen: number; time: number }
  >();
  #totals = new Map<
    string,
    {
      count: number;
      unseen: number;
      statuses: Map<ProjectStatus, number>;
      times: Map<number, number>;
      last: number;
    }
  >();
  #locationForms: Readonly<Record<string, number>> = {};
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
  #seeds = new Map<string, import("@otk/harness").ProjectSeed>();
  #leafSeeds = new Map<
    string,
    Map<string, import("@otk/harness").ProjectSeed>
  >();
  #seeded = false;
  #topology = new Map<string, ProjectTopology>();
  #leaves = new Map<string, Set<string>>();
  #direct = new Map<string, ProjectSummary>();
  /** Never merge by path alone: a nested working directory must share repo identity. */
  leaf(directory: string, repoID?: string): string {
    const exact = this.#seeds.get(directory)?.topology;
    if (exact && (!repoID || exact.repoID === repoID)) {
      return exact.leafDirectory;
    }
    let root = directory;
    let length = -1;
    for (const topology of this.#topology.values()) {
      if (topology.repoID !== repoID) continue;
      const candidate = topology.leafDirectory;
      if (
        (directory === candidate || directory.startsWith(candidate + "/")) &&
        candidate.length > length
      ) {
        root = candidate;
        length = candidate.length;
      }
    }
    return root;
  }
  context(directory: string): string | undefined {
    return this.#topology.get(directory)?.parentDirectory;
  }
  seed(
    values: readonly import("@otk/harness").ProjectSeed[],
  ): readonly IndexMetadata[] {
    this.#seeded = true;
    values = values.map((value) =>
      value.topology === undefined
        ? { ...value, topology: this.#seeds.get(value.directory)?.topology }
        : value
    );
    const repos = new Set<string>(), dirty = new Set<string>();
    for (const value of values) {
      const before = this.#seeds.get(value.directory);
      dirty.add(this.leaf(value.directory));
      if (JSON.stringify(before?.topology) !== JSON.stringify(value.topology)) {
        for (const topology of [before?.topology, value.topology]) {
          if (!topology) continue;
          repos.add(topology.repoID);
          dirty.add(topology.canonicalRoot);
          dirty.add(topology.leafDirectory);
        }
      }
    }
    const affected = [...repos].flatMap((
      repo,
    ) => [...this.#repoSessions.get(repo) ?? []]);
    for (const id of affected) {
      const entry = this.#sessions.get(id)!;
      const directory = this.leaf(entry.directory, entry.projectID);
      this.#contribute(entry, -1);
      this.#projects.get(directory)?.delete(id);
      dirty.add(directory);
    }
    for (const value of values) {
      this.#seeds.set(value.directory, {
        ...value,
        hasSessions: value.hasSessions ??
          this.#seeds.get(value.directory)?.hasSessions,
      });
    }
    this.#topology.clear();
    for (const value of this.#seeds.values()) {
      if (value.topology) {
        this.#topology.set(value.topology.leafDirectory, value.topology);
      }
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
      if (!this.#topology.has(topology.canonicalRoot)) {
        this.#topology.set(topology.canonicalRoot, {
          ...topology,
          leafDirectory: topology.canonicalRoot,
          parentDirectory: undefined,
        });
      }
    }
    // Reparent only affected repos; count-only seeds never traverse sessions.
    // Session/task identities and persisted marks retain their exact scope.
    for (const id of affected) {
      const entry = this.#sessions.get(id)!;
      const directory = this.leaf(entry.directory, entry.projectID);
      const project = this.#projects.get(directory) ?? new Map();
      project.set(entry.id, entry);
      this.#projects.set(directory, project);
      this.#contribute(entry, 1);
      dirty.add(directory);
    }
    for (const seed of values) {
      dirty.add(this.leaf(seed.directory));
    }
    for (const directory of dirty) {
      if (!this.#projects.has(directory)) {
        this.#projects.set(directory, new Map());
      }
      this.#update(directory);
    }
    this.retain(this.#known);
    return affected.map((id) => this.#sessions.get(id)!);
  }
  constructor(
    readonly marks: (id: string) => { seen: number; finish: number },
    readonly publish: (summary: ProjectSummary) => void,
    readonly retire: (directory: string) => void = () => {},
    readonly supervision = new SessionSupervision(),
  ) {}
  ensure(directory: string): void {
    this.#known.add(directory);
    directory = this.leaf(directory);
    if (!this.#projects.has(directory)) {
      this.#projects.set(directory, new Map());
    }
    if (!this.values.has(directory)) this.#update(directory);
  }
  retain(directories: Iterable<string>): void {
    this.#known = new Set(directories);
    for (const directory of this.#known) this.ensure(directory);
    for (const [directory, entries] of this.#projects) {
      if (
        entries.size || this.#known.has(directory) ||
        this.#leafSeeds.has(directory) || this.#leaves.has(directory) ||
        this.#locationForms[directory]
      ) {
        this.#publish(directory);
        continue;
      }
      this.#projects.delete(directory);
      this.#totals.delete(directory);
      this.#direct.delete(directory);
      this.values.delete(directory);
      this.retire(directory);
    }
  }
  authority(value: ProjectSummary["authority"]): void {
    this.#authority = value;
    this.supervision.freshness(value !== "stale");
    if (value !== "stale") this.#catalog = true;
    this.refresh();
  }
  entry(entry: IndexMetadata): void {
    const before = this.#sessions.get(entry.id);
    if (JSON.stringify(before) === JSON.stringify(entry)) return;
    if (before) {
      this.#repoSessions.get(before.projectID)?.delete(entry.id);
      this.#contribute(before, -1);
      this.#projects.get(this.leaf(before.directory, before.projectID))?.delete(
        entry.id,
      );
    }
    this.#sessions.set(entry.id, entry);
    const repo = this.#repoSessions.get(entry.projectID) ?? new Set();
    repo.add(entry.id);
    this.#repoSessions.set(entry.projectID, repo);
    const directory = this.leaf(entry.directory, entry.projectID);
    const project = this.#projects.get(directory) ?? new Map();
    project.set(entry.id, entry);
    this.#projects.set(directory, project);
    this.#contribute(entry, 1);
    if (before && this.leaf(before.directory, before.projectID) !== directory) {
      this.#update(this.leaf(before.directory, before.projectID));
    }
    this.#update(directory);
  }
  remove(id: string): void {
    const before = this.#sessions.get(id);
    if (!before) return;
    this.#contribute(before, -1);
    this.#sessions.delete(id);
    this.#repoSessions.get(before.projectID)?.delete(id);
    const directory = this.leaf(before.directory, before.projectID);
    this.#projects.get(directory)?.delete(id);
    this.#update(directory);
    this.retain(this.#known);
  }
  mark(id: string): void {
    const entry = this.#sessions.get(id);
    if (entry) {
      this.#contribute(entry, -1);
      this.#contribute(entry, 1);
      this.#update(this.leaf(entry.directory, entry.projectID));
    }
  }
  permissions(lookup: (id: string) => number): void {
    this.supervision.permissions(lookup);
    this.refresh();
  }
  refresh(): void {
    for (const entry of this.#sessions.values()) {
      this.#contribute(entry, -1);
      this.#contribute(entry, 1);
    }
    for (const directory of this.#projects.keys()) this.#update(directory);
  }
  #contribute(entry: IndexMetadata, sign: 1 | -1): void {
    if (entry.deleted) return;
    const directory = this.leaf(entry.directory, entry.projectID);
    let totals = this.#totals.get(directory);
    if (!totals) {
      totals = {
        count: 0,
        unseen: 0,
        statuses: new Map(),
        times: new Map(),
        last: 0,
      };
      this.#totals.set(directory, totals);
    }
    const marks = this.marks(entry.id);
    const value = this.supervision.session(entry, marks.seen, marks.finish);
    const unseen = Number(value.terminal > marks.seen);
    const fact = sign === -1 ? this.#facts.get(entry.id)! : {
      status: this.supervision.status(value),
      unseen,
      time: entry.timeUpdated,
    };
    if (!fact) return;
    totals.count += sign;
    totals.unseen += sign * fact.unseen;
    totals.statuses.set(
      fact.status,
      (totals.statuses.get(fact.status) ?? 0) + sign,
    );
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
  #update(directory: string): void {
    const entries = this.#projects.get(directory)!;
    const totals = this.#totals.get(directory);
    const count = totals?.count ?? 0,
      unseen = totals?.unseen ?? 0,
      last = totals?.last ?? 0;
    const previous = this.values.get(directory);
    const locationForms = this.#locationForms[directory] ?? 0;
    const authority = this.#authority === "stale"
      ? previous?.authority === "unknown" ? "unknown" : "stale"
      : locationForms
      ? "current"
      : entries.size
      ? "current"
      : this.#authority;
    const status = locationForms
      ? "blocked"
      : PROJECT_STATUS_PRIORITY.find((s) =>
        (totals?.statuses.get(s) ?? 0) > 0
      ) ??
        "none";
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
      ...(locationForms ? { locationForms } : {}),
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
      ...(this.#topology.has(directory)
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
    const summary: ProjectSummary = summaries?.length
      ? {
        ...direct,
        direct,
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
          ? summaries.reduce((n, s) => n + s.unseenCount!, 0)
          : null,
        lastActivity: summaries.every((s) => s.lastActivity !== null)
          ? Math.max(...summaries.map((s) => s.lastActivity!))
          : null,
        status: PROJECT_STATUS_PRIORITY.find((status) =>
          summaries.some((s) => s.status === status)
        ) ?? "none",
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
      !this.#known.has(directory) &&
      !summary.scopes?.some((scope) => this.#known.has(scope)) &&
      !this.#projects.get(directory)?.size
    ) {
      if (this.values.delete(directory)) this.retire(directory);
      return;
    }
    if (
      JSON.stringify(summary) === JSON.stringify(this.values.get(directory))
    ) return;
    this.values.set(directory, summary);
    this.publish(summary);
  }
}
