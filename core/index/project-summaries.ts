// SPDX-License-Identifier: LGPL-3.0-only
import {
  type IndexMetadata,
  PROJECT_STATUS_PRIORITY,
  type ProjectStatus,
  type ProjectSummary,
} from "@otk/protocol";

/** Scalar, keyed project owner. It never reads native APIs, digests or usage. */
export class ProjectSummaries {
  readonly values = new Map<string, ProjectSummary>();
  #sessions = new Map<string, IndexMetadata>();
  #projects = new Map<string, Map<string, IndexMetadata>>();
  #facts = new Map<
    string,
    { status: ProjectStatus; unseen: number; time: number; unknown: number }
  >();
  #totals = new Map<
    string,
    {
      count: number;
      unseen: number;
      unknown: number;
      statuses: Map<ProjectStatus, number>;
      times: Map<number, number>;
      last: number;
    }
  >();
  #permissions?: (id: string) => number;
  #authority: ProjectSummary["authority"] = "unknown";
  #catalog = false;
  #known = new Set<string>();
  #seeds = new Map<string, import("@otk/harness").ProjectSeed>();
  #seeded = false;
  seed(values: readonly import("@otk/harness").ProjectSeed[]): void {
    this.#seeded = true;
    for (const value of values) {
      this.#seeds.set(value.directory, value);
      this.ensure(value.directory);
      this.#update(value.directory);
    }
  }
  constructor(
    readonly marks: (id: string) => { seen: number; finish: number },
    readonly publish: (summary: ProjectSummary) => void,
    readonly retire: (directory: string) => void = () => {},
  ) {}
  ensure(directory: string): void {
    if (!this.#projects.has(directory)) {
      this.#projects.set(directory, new Map());
      this.#update(directory);
    }
  }
  retain(directories: Iterable<string>): void {
    this.#known = new Set(directories);
    for (const directory of this.#known) this.ensure(directory);
    for (const [directory, entries] of this.#projects) {
      if (
        entries.size || this.#known.has(directory) || this.#seeds.has(directory)
      ) continue;
      this.#projects.delete(directory);
      this.#totals.delete(directory);
      this.values.delete(directory);
      this.retire(directory);
    }
  }
  authority(value: ProjectSummary["authority"]): void {
    this.#authority = value;
    if (value !== "stale") this.#catalog = true;
    this.refresh();
  }
  entry(entry: IndexMetadata): void {
    const before = this.#sessions.get(entry.id);
    if (JSON.stringify(before) === JSON.stringify(entry)) return;
    if (before) {
      this.#contribute(before, -1);
      this.#projects.get(before.directory)?.delete(entry.id);
    }
    this.#sessions.set(entry.id, entry);
    const project = this.#projects.get(entry.directory) ?? new Map();
    project.set(entry.id, entry);
    this.#projects.set(entry.directory, project);
    this.#contribute(entry, 1);
    if (before && before.directory !== entry.directory) {
      this.#update(before.directory);
    }
    this.#update(entry.directory);
  }
  remove(id: string): void {
    const before = this.#sessions.get(id);
    if (!before) return;
    this.#contribute(before, -1);
    this.#sessions.delete(id);
    this.#projects.get(before.directory)?.delete(id);
    this.#update(before.directory);
    this.retain(this.#known);
  }
  mark(id: string): void {
    const entry = this.#sessions.get(id);
    if (entry) {
      this.#contribute(entry, -1);
      this.#contribute(entry, 1);
      this.#update(entry.directory);
    }
  }
  permissions(lookup: (id: string) => number): void {
    this.#permissions = lookup;
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
    let totals = this.#totals.get(entry.directory);
    if (!totals) {
      totals = {
        count: 0,
        unseen: 0,
        unknown: 0,
        statuses: new Map(),
        times: new Map(),
        last: 0,
      };
      this.#totals.set(entry.directory, totals);
    }
    const a = entry.attention, marks = this.marks(entry.id);
    const unseen = Number(!entry.parentID && marks.finish > marks.seen);
    const fact = sign === -1 ? this.#facts.get(entry.id)! : {
      status: a.error ||
          a.questions + a.childQuestions +
                (this.#authority !== "stale" && this.#permissions
                  ? this.#permissions(entry.id)
                  : a.permissions + a.childPermissions) > 0
        ? "blocked" as const
        : entry.status !== "idle"
        ? "working" as const
        : unseen
        ? "finished" as const
        : "idle" as const,
      unseen,
      time: entry.timeUpdated,
      unknown: Number(
        entry.activityAuthority === "unknown" ||
          entry.activityAuthority === "stale",
      ),
    };
    if (!fact) return;
    totals.count += sign;
    totals.unseen += sign * fact.unseen;
    totals.unknown += sign * fact.unknown;
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
      last = totals?.last ?? 0,
      unknown = (totals?.unknown ?? 0) > 0;
    const previous = this.values.get(directory);
    const authority = this.#authority === "stale"
      ? previous?.authority === "unknown" ? "unknown" : "stale"
      : unknown
      ? "unknown"
      : entries.size
      ? "current"
      : this.#authority;
    const status =
      PROJECT_STATUS_PRIORITY.find((s) => (totals?.statuses.get(s) ?? 0) > 0) ??
        "idle";
    const knownCount = this.#catalog;
    const seed = this.#seeds.get(directory);
    const summary: ProjectSummary = {
      directory,
      hasSessions: seed?.hasSessions || count > 0,
      status: authority === "unknown" && status === "idle" ? null : status,
      sessionCount: seed
        ? seed.sessionCount
        : knownCount && !this.#seeded
        ? count
        : null,
      unseenCount: seed || knownCount ? unseen : null,
      lastActivity: seed
        ? Math.max(seed.lastActivity ?? 0, last)
        : knownCount && !this.#seeded
        ? last
        : null,
      authority,
    };
    if (JSON.stringify(summary) === JSON.stringify(previous)) return;
    this.values.set(directory, summary);
    this.publish(summary);
  }
}
