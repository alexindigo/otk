// SPDX-License-Identifier: LGPL-3.0-only
import {
  archiveEntityID,
  type BlockedCause,
  type ComposerLinkState,
  type EntityCounts,
  entityKey,
  type EntityState,
  type HelperDisposition,
  type IndexMetadata,
  projectPlacement,
  type ProjectStatus,
  type ProjectSummary,
  rollupStatus,
  type RunningShells,
  type SessionEvidence,
  type Supervision,
  taskEntityID,
  type TaskHelpers,
} from "@otk/protocol";
import {
  failedHelperNeedsAck,
  type SessionInputs,
  type SessionSupervision,
} from "./supervision.ts";

const PERMISSION_GRACE_MS = 500;
const noShells: RunningShells = { items: [], count: 0, state: "none" };

interface EntityClock {
  now(): number;
  set(run: () => void, delay: number): unknown;
  clear(timer: unknown): void;
}
type PermissionWake = { at: number; timer?: unknown };
const systemClock: EntityClock = {
  now: () => performance.now(),
  set: (run, delay) => setTimeout(run, delay),
  clear: (timer) => clearTimeout(timer as number),
};

/** Session family facts the owner borrows; it never scans the catalog. */
export interface EntityFamily {
  getMetadata(id: string): IndexMetadata | undefined;
  ancestors(id: string): readonly string[];
  descendants(id: string): ReadonlySet<string>;
}

/** A member's contribution to the counts: itself, by its own state. */
function own(state: ProjectStatus, unseen: boolean): EntityCounts {
  return {
    blocked: state === "blocked" ? 1 : 0,
    working: state === "working" ? 1 : 0,
    finished: state === "finished" ? 1 : 0,
    unseen: unseen ? 1 : 0,
  };
}

/** Members of an aggregate by state; graced counts members blocked only by a
 * permission, and requests holds those permissions' identities, so an
 * aggregate shares its members' per-request grace (addendum 1). */
interface Tally {
  counts: EntityCounts;
  dependencies: number;
  graced: number;
  requests: Map<string, number>;
}
interface Listing {
  tasks: Map<string, number>;
  sum: Tally;
}
/** One session's share of its aggregates. */
interface Contribution {
  counts: EntityCounts;
  dependencies: number;
  graced: number;
  requests: readonly string[];
}
function tally(): Tally {
  return {
    counts: own("none", false),
    dependencies: 0,
    graced: 0,
    requests: new Map(),
  };
}
function add(target: Tally, value: Contribution | Tally, sign: 1 | -1): void {
  target.counts.blocked += sign * value.counts.blocked;
  target.counts.working += sign * value.counts.working;
  target.counts.finished += sign * value.counts.finished;
  target.counts.unseen += sign * value.counts.unseen;
  target.dependencies += sign * value.dependencies;
  target.graced += sign * value.graced;
  const requests = value.requests instanceof Map
    ? [...value.requests]
    : value.requests.map((id) => [id, 1] as const);
  for (const [id, count] of requests) {
    const next = (target.requests.get(id) ?? 0) + sign * count;
    if (next) target.requests.set(id, next);
    else target.requests.delete(id);
  }
}

/** Decision 62: the one per-user state of every entity, updated from signals.
 * Session state is SessionSupervision's verdict; every indicator derives from
 * the published EntityState, never from a second interpretation. */
export class EntityStates {
  #permissions = new Map<
    string,
    {
      due: Map<string, number>;
      through: number;
      wake?: PermissionWake;
      refresh: () => void;
    }
  >();
  #states = new Map<string, EntityState>();
  /** Own counts of each live session, for its ancestors' descendant evidence. */
  #own = new Map<string, EntityCounts>();
  /** Last published parent, so a moved or removed session updates its old family. */
  #parents = new Map<string, string>();
  /** Sessions whose only blocker is a permission, with those requests. */
  #graced = new Map<string, readonly string[]>();
  /** Placement facts from ProjectSummaries: session checkout, checkout forms
   * and the checkouts of each project. Aggregates update by delta (D57). */
  #checkoutOf = new Map<string, string>();
  #listed = new Map<string, Listing>();
  #projectListings = new Map<string, Listing>();
  #archiveListings = new Map<string, Listing>();
  #viewsOf = new Map<string, Set<Listing>>();
  #listingRevision = 0;
  #forms = new Map<string, number>();
  #checkoutDependencies = new Map<string, number>();
  #terminalOwners: (id: string) => number = () => 0;
  #leaves = new Map<string, readonly string[]>();
  #projectsOf = new Map<string, Set<string>>();
  #placement = new Map<
    string,
    Pick<ProjectSummary, "directory" | "archived" | "availability" | "topology">
  >();
  #archiveOf = new Map<string, string>();
  #archiveLeaves = new Map<string, Set<string>>();
  /** D69/D70: one partition over native ancestry, independent of all views. */
  #roots: ReadonlyMap<string, string> = new Map();
  #taskOf = new Map<string, string>();
  #members = new Map<string, Set<string>>();
  #checkoutsOf = new Map<string, Set<string>>();
  #taskTallies = new Map<string, Tally>();
  #global = tally();
  /** S22: received OTK operations by target session. */
  #operations = new Map<string, "working" | "blocked">();
  /** S22: received operations without a session, by checkout directory. */
  #checkoutOperations = new Map<string, "working" | "blocked">();
  constructor(
    readonly supervision: SessionSupervision,
    readonly family: EntityFamily,
    readonly publish: (
      upserts: readonly EntityState[],
      removals: readonly string[],
    ) => void,
    readonly clock: EntityClock = systemClock,
    readonly onPermissionDeadline?: (id: string) => void,
    readonly openedByUser: (id: string) => boolean = () => false,
  ) {}
  get(key: string): EntityState | undefined {
    return this.#states.get(key);
  }
  /** Selected composer scope: borrow the own work and the assigned task roster.
   * No sibling enumeration or fanout to every session when a helper changes. */
  composerLink(id: string): ComposerLinkState {
    const session = this.get(entityKey("session", id));
    if (!session) return "none";
    const task = this.#taskOf.get(id);
    const helpers = task
      ? this.get(entityKey("task", task))?.helpers
      : undefined;
    if (
      session.evidence?.nativeRun || session.evidence?.continuation ||
      session.shells?.state === "working" ||
      helpers?.counts.running
    ) {
      return "running";
    }
    return helpers?.ids.length ? "idle" : "none";
  }
  terminalOwners(count: (id: string) => number): void {
    this.#terminalOwners = count;
  }
  /** The live keyed map, copied by snapshot assembly like the other maps. */
  values(): Map<string, EntityState> {
    return this.#states;
  }
  /** A new user generation starts without transitions from the previous one. */
  reset(): void {
    for (const lifetime of this.#permissions.values()) {
      this.clock.clear(lifetime.wake?.timer);
      lifetime.wake = undefined;
    }
    this.#states.clear();
    this.#own.clear();
    this.#parents.clear();
    this.#graced.clear();
    // ProjectSummaries retains structural placements across user generations.
    this.#listed.clear();
    this.#projectListings.clear();
    this.#archiveListings.clear();
    this.#viewsOf.clear();
    this.#listingRevision++;
    this.#forms.clear();
    this.#checkoutDependencies.clear();
    this.#leaves.clear();
    this.#projectsOf.clear();
    this.#placement.clear();
    this.#archiveOf.clear();
    this.#archiveLeaves.clear();
    this.#taskOf.clear();
    this.#members.clear();
    this.#checkoutsOf.clear();
    this.#taskTallies.clear();
    this.#global = tally();
    this.#operations.clear();
    this.#checkoutOperations.clear();
  }
  close(): void {
    for (const lifetime of this.#permissions.values()) {
      this.clock.clear(lifetime.wake?.timer);
    }
    this.#permissions.clear();
  }

  #permissionKeys(
    entry: IndexMetadata,
    count: number,
    refresh: () => void,
  ): string[] {
    const previous = this.#permissions.get(entry.id);
    const wake = previous?.wake;
    if (entry.deleted) {
      this.clock.clear(wake?.timer);
      this.#permissions.delete(entry.id);
      return [];
    }
    const input = entry.activity?.permissions;
    if (!input?.fresh) {
      // Native source loss is not settlement. A fresh snapshot reconciles IDs.
      this.clock.clear(wake?.timer);
      if (previous) previous.wake = undefined;
      return [];
    }
    if (!input.keys.length) {
      this.clock.clear(wake?.timer);
      this.#permissions.delete(entry.id);
      return [];
    }
    const now = this.clock.now();
    const due = new Map(
      input.keys.map((
        id,
      ) => [id, previous?.due.get(id) ?? now + PERMISSION_GRACE_MS]),
    );
    const active: string[] = [];
    const through = previous?.through ?? -Infinity;
    let next = Infinity;
    if (count > 0) {
      for (const [id, at] of due) {
        if (at <= through) active.push(id);
        else next = Math.min(next, at);
      }
    }
    // Only the deadline callback releases the grace. A summary refresh can
    // arrive after the deadline but before its callback; reading the clock
    // there would publish a lamp before Inbox reconciles persisted policy.
    const retainWake = wake?.at === next;
    const lifetime = {
      due,
      through,
      wake: retainWake ? wake : undefined,
      refresh,
    };
    this.#permissions.set(entry.id, lifetime);
    if (!retainWake) {
      this.clock.clear(wake?.timer);
      if (Number.isFinite(next)) {
        const pending: PermissionWake = { at: next };
        lifetime.wake = pending;
        pending.timer = this.clock.set(() => {
          const current = this.#permissions.get(entry.id);
          if (current?.wake !== pending) return;
          current.wake = undefined;
          current.through = Math.max(pending.at, this.clock.now());
          current.refresh();
        }, Math.max(0, next - now));
      }
    }
    return active.slice(0, count);
  }

  /** A received operation owned by a project directory (e.g. a creation
   * before its session exists) colours that checkout and its projects. */
  checkoutOperation(directory: string, value?: "working" | "blocked"): void {
    if (value) this.#checkoutOperations.set(directory, value);
    else this.#checkoutOperations.delete(directory);
    const upserts: EntityState[] = [];
    this.#checkout(directory, upserts);
    if (upserts.length) this.publish(upserts, []);
  }
  /** Record a session's received-operation input; the caller re-derives it. */
  operation(id: string, value?: "working" | "blocked"): void {
    if (value) this.#operations.set(id, value);
    else this.#operations.delete(id);
  }
  /** Root record edits affect just those roots' trees. */
  roots(next: ReadonlyMap<string, string>): void {
    const before = this.#roots;
    this.#roots = new Map(next);
    const upserts: EntityState[] = [], removals: string[] = [];
    const dirty = new Set<string>(), checkouts = new Set<string>();
    for (const root of new Set([...before.keys(), ...next.keys()])) {
      if (before.get(root) === next.get(root)) continue;
      for (const id of this.family.descendants(root)) {
        this.#assign(id, this.#contribution(id), dirty, checkouts);
      }
    }
    this.#refreshTasks(dirty, checkouts, upserts, removals);
    if (upserts.length || removals.length) this.publish(upserts, removals);
  }

  taskOf(id: string): string | undefined {
    return this.#taskOf.get(id);
  }

  listed(checkout: string): Iterable<string> {
    return this.#listed.get(checkout)?.tasks.keys() ?? [];
  }

  get listingRevision(): number {
    return this.#listingRevision;
  }
  /** S18: the checkout a session belongs to, as placed by ProjectSummaries. */
  member(id: string, checkout?: string): void {
    const before = this.#checkoutOf.get(id);
    if (before === checkout) return;
    const upserts: EntityState[] = [];
    const task = this.#taskOf.get(id);
    if (before) {
      if (task) this.#list(before, task, -1);
      this.#checkout(before, upserts);
    }
    if (checkout) {
      this.#checkoutOf.set(id, checkout);
      if (task) this.#list(checkout, task, 1);
      this.#checkout(checkout, upserts);
    } else this.#checkoutOf.delete(id);
    if (upserts.length) this.publish(upserts, []);
  }
  /** S21: a checkout's state with its fresh location forms. */
  checkout(directory: string, forms: number, dependencies = 0): EntityState {
    if (forms) this.#forms.set(directory, forms);
    else this.#forms.delete(directory);
    if (dependencies) this.#checkoutDependencies.set(directory, dependencies);
    else this.#checkoutDependencies.delete(directory);
    const upserts: EntityState[] = [];
    this.#checkout(directory, upserts);
    if (upserts.length) this.publish(upserts, []);
    return this.#states.get(entityKey("checkout", directory))!;
  }
  /** A project's state over its checkouts (or itself when it has none). */
  project(directory: string, checkouts: readonly string[]): EntityState {
    const previous = this.#leaves.get(directory) ?? [];
    const next = [...new Set(checkouts.length ? checkouts : [directory])];
    const listing = this.#listing(this.#projectListings, directory);
    for (const leaf of previous) {
      if (next.includes(leaf)) continue;
      this.#projectsOf.get(leaf)?.delete(directory);
      for (const task of this.listed(leaf)) this.#include(listing, task, -1);
    }
    this.#leaves.set(directory, next);
    for (const leaf of next) {
      if (previous.includes(leaf)) continue;
      const projects = this.#projectsOf.get(leaf) ?? new Set<string>();
      projects.add(directory);
      this.#projectsOf.set(leaf, projects);
      for (const task of this.listed(leaf)) this.#include(listing, task, 1);
    }
    const upserts: EntityState[] = [];
    this.#project(directory, upserts);
    if (upserts.length) this.publish(upserts, []);
    return this.#states.get(entityKey("project", directory))!;
  }
  /** A directory is no longer summarized: its aggregates are gone. */
  placement(
    facts: Pick<
      ProjectSummary,
      "directory" | "archived" | "availability" | "topology"
    >,
  ): void {
    this.#placement.set(facts.directory, {
      directory: facts.directory,
      archived: facts.archived,
      availability: facts.availability,
      topology: facts.topology,
    });
    const upserts: EntityState[] = [];
    this.#placeArchive(facts.directory, upserts);
    if (upserts.length) this.publish(upserts, []);
  }

  drop(directory: string): void {
    const upserts: EntityState[] = [];
    this.#placement.delete(directory);
    this.#placeArchive(directory, upserts);
    const removals: string[] = [];
    for (const kind of ["checkout", "project"] as const) {
      const key = entityKey(kind, directory);
      if (this.#states.delete(key)) removals.push(key);
    }
    for (const leaf of this.#leaves.get(directory) ?? []) {
      this.#projectsOf.get(leaf)?.delete(directory);
    }
    const listing = this.#projectListings.get(directory);
    if (listing) {
      for (const id of listing.tasks.keys()) {
        this.#viewsOf.get(id)?.delete(listing);
      }
      this.#projectListings.delete(directory);
    }
    this.#leaves.delete(directory);
    this.#forms.delete(directory);
    this.#checkoutDependencies.delete(directory);
    if (upserts.length || removals.length) this.publish(upserts, removals);
  }
  /** Interpret one session, publish its state and its ancestors' descendant
   * evidence. Returns the supervision verdict it was derived from. */
  session(
    entry: IndexMetadata,
    acknowledged: number,
    retainedTerminal = 0,
  ): Supervision {
    const native = this.supervision.inputs(entry);
    const permissions = this.#permissionKeys(entry, native.permissions, () => {
      if (this.onPermissionDeadline) this.onPermissionDeadline(entry.id);
      else this.session(entry, acknowledged, retainedTerminal);
    });
    const inputs = { ...native, permissions: permissions.length };
    const operation = this.#operations.get(entry.id);
    const verdict = this.supervision.session(
      entry,
      acknowledged,
      retainedTerminal,
      inputs,
      operation,
    );
    const upserts: EntityState[] = [], removals: string[] = [];
    const contribution = this.#contribution(entry.id);
    const parent = this.#parents.get(entry.id);
    const moved = parent !== entry.parentID;
    const admitted = !this.#own.has(entry.id);
    const previous = this.#states.get(entityKey("session", entry.id));
    const tasks = new Set<string>(), checkouts = new Set<string>();
    if (moved) {
      if (parent) this.#chain(parent, upserts);
      if (entry.parentID) this.#parents.set(entry.id, entry.parentID);
      else this.#parents.delete(entry.id);
    }
    if (entry.deleted) {
      this.#retire(entry.id, removals);
      this.#ancestors(entry.id, upserts);
    } else {
      const state = rollupStatus(this.supervision.status(verdict), operation);
      const counts = own(state, verdict.unseen === true);
      this.#own.set(entry.id, counts);
      const value = this.#session(
        entry,
        verdict,
        state,
        counts,
        inputs,
        permissions,
        operation,
      );
      if (value.cause === "permission") {
        this.#graced.set(
          entry.id,
          (value.evidence?.requests?.permissions ?? []).map((r) => r.id)
            .sort(),
        );
      } else this.#graced.delete(entry.id);
      if (this.#set(value)) upserts.push(value);
      // Helper title, live-work and retry evidence may change without a count
      // change. Refresh only this family's ancestors, not the catalog.
      this.#ancestors(entry.id, upserts);
    }
    if (admitted || moved || entry.deleted) {
      for (
        const id of new Set([entry.id, ...this.family.descendants(entry.id)])
      ) {
        this.#assign(
          id,
          id === entry.id ? contribution : this.#contribution(id),
          tasks,
          checkouts,
        );
      }
    }
    const current = this.#states.get(entityKey("session", entry.id));
    const task = this.#taskOf.get(entry.id);
    if (
      task && (
        previous?.evidence?.helper !== current?.evidence?.helper ||
        current?.evidence?.helper && (
            previous?.evidence?.run?.startedAt !==
              current.evidence.run?.startedAt ||
            previous?.terminal !== current.terminal
          )
      )
    ) tasks.add(task);
    this.#contribute(entry.id, contribution, tasks, checkouts, upserts);
    this.#refreshTasks(tasks, checkouts, upserts, removals);
    if (upserts.length || removals.length) this.publish(upserts, removals);
    return verdict;
  }
  /** A session left the index: its state is none and its entity is gone. */
  remove(id: string): void {
    const upserts: EntityState[] = [], removals: string[] = [];
    const contribution = this.#contribution(id);
    const parent = this.#parents.get(id);
    this.#retire(id, removals);
    if (parent) this.#chain(parent, upserts);
    const tasks = new Set<string>(), checkouts = new Set<string>();
    for (const member of new Set([id, ...this.family.descendants(id)])) {
      this.#assign(
        member,
        member === id ? contribution : this.#contribution(member),
        tasks,
        checkouts,
      );
    }
    this.#contribute(id, contribution, tasks, checkouts, upserts);
    this.#checkoutOf.delete(id);
    this.#refreshTasks(tasks, checkouts, upserts, removals);
    if (upserts.length || removals.length) this.publish(upserts, removals);
  }
  #contribution(id: string): Contribution {
    const counts = this.#own.get(id);
    return {
      counts: counts ? { ...counts } : own("none", false),
      dependencies: this.#states.get(entityKey("session", id))?.dependencies ??
        0,
      graced: this.#graced.has(id) ? 1 : 0,
      requests: this.#graced.get(id) ?? [],
    };
  }
  /** Move the existing contribution before applying any change in its value. */
  #assign(
    id: string,
    contribution: Contribution,
    tasks: Set<string>,
    checkouts: Set<string>,
  ): void {
    const before = this.#taskOf.get(id);
    let next: string | undefined;
    if (this.#own.has(id)) {
      const root = this.family.ancestors(id).findLast((key) => {
        const entry = this.family.getMetadata(key);
        return !!entry && !entry.deleted;
      }) ?? id;
      next = this.#roots.get(root) ?? taskEntityID("session", root);
    }
    if (before === next) return;
    const checkout = this.#checkoutOf.get(id);
    if (before) {
      this.#delta(before, contribution, -1, tasks, checkouts);
      this.#members.get(before)!.delete(id);
      if (checkout) this.#list(checkout, before, -1);
    }
    if (next) {
      this.#taskOf.set(id, next);
      const members = this.#members.get(next) ?? new Set<string>();
      members.add(id);
      this.#members.set(next, members);
      this.#delta(next, contribution, 1, tasks, checkouts);
      if (checkout) this.#list(checkout, next, 1);
    } else this.#taskOf.delete(id);
    if (checkout) checkouts.add(checkout);
  }

  #delta(
    task: string,
    value: Contribution,
    sign: 1 | -1,
    tasks: Set<string>,
    checkouts: Set<string>,
  ): void {
    const sum = this.#taskTallies.get(task) ?? tally();
    this.#taskTallies.set(task, sum);
    add(sum, value, sign);
    for (const listing of this.#viewsOf.get(task) ?? []) {
      add(listing.sum, value, sign);
    }
    for (const checkout of this.#checkoutsOf.get(task) ?? []) {
      checkouts.add(checkout);
    }
    tasks.add(task);
  }

  #refreshTasks(
    tasks: Set<string>,
    checkouts: Set<string>,
    upserts: EntityState[],
    removals: string[],
  ): void {
    for (const id of tasks) {
      if (!this.#members.get(id)?.size) {
        this.#members.delete(id);
        // Archive placement follows checkout paint below, so its listing may
        // still need the old task's zero tally during reconciliation.
        const key = entityKey("task", id);
        if (this.#states.delete(key)) removals.push(key);
      } else {
        const value = this.#aggregate(
          "task",
          id,
          this.#taskTallies.get(id)!,
          0,
        );
        value.helpers = this.#taskHelpers(this.#members.get(id)!);
        if (this.#set(value)) upserts.push(value);
      }
    }
    for (const checkout of checkouts) this.#checkout(checkout, upserts);
    for (const id of tasks) {
      if (this.#members.has(id)) continue;
      this.#taskTallies.delete(id);
      this.#checkoutsOf.delete(id);
      this.#viewsOf.delete(id);
    }
  }

  /** Global is still a flat set of sessions. Other views borrow their tasks. */
  #contribute(
    id: string,
    before: Contribution,
    tasks: Set<string>,
    checkouts: Set<string>,
    upserts: EntityState[],
  ): void {
    const after = this.#contribution(id);
    if (JSON.stringify(before) === JSON.stringify(after)) return;
    const task = this.#taskOf.get(id);
    if (task) {
      this.#delta(task, before, -1, tasks, checkouts);
      this.#delta(task, after, 1, tasks, checkouts);
    }
    add(this.#global, before, -1);
    add(this.#global, after, 1);
    const value = this.#aggregate("global", "global", this.#global, 0);
    if (this.#set(value)) upserts.push(value);
  }
  #listing(values: Map<string, Listing>, id: string): Listing {
    let value = values.get(id);
    if (!value) values.set(id, value = { tasks: new Map(), sum: tally() });
    return value;
  }

  /** Update a union by reference count, folding a task exactly once. */
  #include(listing: Listing, task: string, sign: 1 | -1): boolean {
    const before = listing.tasks.get(task) ?? 0, count = before + sign;
    if (count) listing.tasks.set(task, count);
    else listing.tasks.delete(task);
    if (!!before === !!count) return false;
    add(listing.sum, this.#taskTallies.get(task)!, sign);
    if (count) {
      const views = this.#viewsOf.get(task) ?? new Set<Listing>();
      views.add(listing);
      this.#viewsOf.set(task, views);
    } else this.#viewsOf.get(task)?.delete(listing);
    return true;
  }

  #list(checkout: string, task: string, sign: 1 | -1): void {
    if (!this.#include(this.#listing(this.#listed, checkout), task, sign)) {
      return;
    }
    this.#listingRevision++;
    const leaves = this.#checkoutsOf.get(task) ?? new Set<string>();
    if (sign === 1) leaves.add(checkout);
    else leaves.delete(checkout);
    this.#checkoutsOf.set(task, leaves);
    for (const project of this.#projectsOf.get(checkout) ?? []) {
      this.#include(this.#listing(this.#projectListings, project), task, sign);
    }
    const archive = this.#archiveOf.get(checkout);
    if (archive) {
      this.#include(this.#listing(this.#archiveListings, archive), task, sign);
    }
  }
  #checkout(directory: string, upserts: EntityState[]): void {
    const value = this.#aggregate(
      "checkout",
      directory,
      this.#listing(this.#listed, directory).sum,
      this.#forms.get(directory) ?? 0,
      this.#checkoutOperations.get(directory),
      this.#checkoutDependencies.get(directory) ?? 0,
    );
    if (this.#set(value)) upserts.push(value);
    this.#placeArchive(directory, upserts);
    for (const project of this.#projectsOf.get(directory) ?? []) {
      this.#project(project, upserts);
    }
  }
  #project(directory: string, upserts: EntityState[]): void {
    let forms = 0;
    let dependencies = 0;
    const operations: ("working" | "blocked")[] = [];
    for (const leaf of this.#leaves.get(directory) ?? [directory]) {
      forms += this.#forms.get(leaf) ?? 0;
      dependencies += this.#checkoutDependencies.get(leaf) ?? 0;
      const operation = this.#checkoutOperations.get(leaf);
      if (operation) operations.push(operation);
    }
    const operation = rollupStatus(...operations);
    const value = this.#aggregate(
      "project",
      directory,
      this.#listing(this.#projectListings, directory).sum,
      forms,
      operation === "none" ? undefined : operation as "working" | "blocked",
      dependencies,
    );
    if (this.#set(value)) upserts.push(value);
  }
  /** C3 placement is shared unchanged with the client. A checkout state change
   * revisits only its old/new archive, never the session population. */
  #placeArchive(directory: string, upserts: EntityState[]): void {
    const facts = this.#placement.get(directory),
      before = this.#archiveOf.get(directory);
    const state = this.#states.get(entityKey("checkout", directory));
    const next = facts &&
        projectPlacement({
            lifecycle: facts,
            status: state?.state ?? "none",
            dependencies: state?.dependencies,
            inactive: false,
            hasSessions: false,
          }).section === "archived"
      ? archiveEntityID(facts)
      : undefined;
    if (before && before !== next) {
      const listing = this.#listing(this.#archiveListings, before);
      for (const task of this.listed(directory)) {
        this.#include(listing, task, -1);
      }
      this.#archiveLeaves.get(before)?.delete(directory);
      this.#archiveOf.delete(directory);
    }
    if (next && next !== before) {
      const listing = this.#listing(this.#archiveListings, next);
      for (const task of this.listed(directory)) {
        this.#include(listing, task, 1);
      }
      const leaves = this.#archiveLeaves.get(next) ?? new Set<string>();
      leaves.add(directory);
      this.#archiveLeaves.set(next, leaves);
      this.#archiveOf.set(directory, next);
    }
    for (const id of new Set([before, next])) {
      if (!id) continue;
      let forms = 0;
      let dependencies = 0;
      for (const leaf of this.#archiveLeaves.get(id) ?? []) {
        forms += this.#forms.get(leaf) ?? 0;
        dependencies += this.#checkoutDependencies.get(leaf) ?? 0;
      }
      const value = this.#aggregate(
        "archive",
        id,
        this.#listing(this.#archiveListings, id).sum,
        forms,
        undefined,
        dependencies,
      );
      if (this.#set(value)) upserts.push(value);
    }
  }
  /** Decision 57 over members: blocked > working > finished > none. */
  #aggregate(
    kind: EntityState["kind"],
    id: string,
    members: Tally,
    forms: number,
    operation?: "working" | "blocked",
    dependencies = members.dependencies,
  ): EntityState {
    const { counts } = members;
    const state = rollupStatus(
      counts.blocked || forms ? "blocked" : undefined,
      operation,
      counts.working ? "working" : undefined,
      counts.finished ? "finished" : undefined,
      dependencies ? "dependencies" : undefined,
    );
    const cause: BlockedCause | undefined = state !== "blocked"
      ? undefined
      : !counts.blocked
      ? forms ? "form" : "operation"
      : !forms && operation !== "blocked" && members.graced === counts.blocked
      ? "permission"
      : undefined;
    const before = this.#states.get(entityKey(kind, id));
    return {
      kind,
      id,
      state,
      ...(cause ? { cause } : {}),
      previous: !before
        ? "none"
        : before.state !== state
        ? before.state
        : before.previous,
      counts: { ...counts },
      ...(dependencies ? { dependencies } : {}),
      ...(cause === "permission"
        ? {
          requests: [...members.requests.keys()].sort().map((id) => ({ id })),
        }
        : {}),
    };
  }
  #retire(id: string, removals: string[]): void {
    this.clock.clear(this.#permissions.get(id)?.wake?.timer);
    this.#permissions.delete(id);
    this.#own.delete(id);
    this.#parents.delete(id);
    this.#graced.delete(id);
    const key = entityKey("session", id);
    if (this.#states.delete(key)) removals.push(key);
  }
  #ancestors(id: string, upserts: EntityState[]): void {
    for (const parent of this.family.ancestors(id)) {
      this.#refresh(parent, upserts);
    }
  }

  #taskHelpers(members: ReadonlySet<string>): TaskHelpers {
    const groups: Record<HelperDisposition, EntityState[]> = {
      running: [],
      needsYou: [],
      finished: [],
      opened: [],
    };
    for (const id of members) {
      const state = this.#states.get(entityKey("session", id));
      const helper = state?.evidence?.helper;
      if (helper) groups[helper].push(state);
    }
    const active = (a: EntityState, b: EntityState) =>
      (a.evidence?.run?.startedAt ?? Infinity) -
        (b.evidence?.run?.startedAt ?? Infinity) ||
      (this.family.getMetadata(a.id)?.timeCreated ?? Infinity) -
        (this.family.getMetadata(b.id)?.timeCreated ?? Infinity) ||
      a.id.localeCompare(b.id);
    const { running, needsYou, finished, opened } = groups;
    // Group lamps describe the counted disposition, not the member's own
    // session lamp (an unseen failure may still have a red session lamp).
    const lamps: NonNullable<TaskHelpers["lamps"]>["groups"] = {
      running: { state: running.length ? "working" : "none" },
      needsYou: { state: needsYou.length ? "blocked" : "none" },
      finished: { state: finished.length ? "finished" : "none" },
      ...(opened.length ? { opened: { state: "none" } } : {}),
    };
    return {
      counts: {
        running: running.length,
        needsYou: needsYou.length,
        finished: finished.length,
        ...(opened.length ? { opened: opened.length } : {}),
      },
      lamps: {
        all: {
          state: rollupStatus(
            lamps.running.state,
            lamps.needsYou.state,
            lamps.finished.state,
          ),
        },
        groups: lamps,
      },
      ids: [
        ...running.sort(active),
        ...needsYou.sort(active),
        ...finished.sort((a, b) =>
          (b.terminal ?? 0) - (a.terminal ?? 0) || a.id.localeCompare(b.id)
        ),
        ...opened.sort((a, b) => a.id.localeCompare(b.id)),
      ].map((value) => value.id),
    };
  }
  /** Undefined means the task is unknown; an empty roster is a valid no-op. */
  finishedHelpers(task: string): string[] | undefined {
    const value = this.get(entityKey("task", task));
    return value &&
      (value.helpers?.ids ?? []).filter((id) => {
        const disposition = this.get(entityKey("session", id))?.evidence
          ?.helper;
        return disposition === "finished" || disposition === "opened";
      });
  }
  /** The full family, not the checkout's view of it (D70). */
  subtree(id: string): string[] {
    return [...new Set([id, ...this.family.descendants(id)])].filter((id) =>
      !this.family.getMetadata(id)?.deleted
    );
  }
  #chain(id: string, upserts: EntityState[]): void {
    this.#refresh(id, upserts);
    this.#ancestors(id, upserts);
  }
  #refresh(id: string, upserts: EntityState[]): void {
    const current = this.#states.get(entityKey("session", id));
    if (!current?.evidence) return;
    const descendants = this.#descendants(id);
    const liveWork = [
      ...(current.evidence.liveWork ?? []).filter((item) =>
        item.kind !== "helper"
      ),
      ...this.#helpers(id),
    ];
    if (
      JSON.stringify(descendants) ===
        JSON.stringify(current.evidence.descendants) &&
      JSON.stringify(liveWork) ===
        JSON.stringify(current.evidence.liveWork ?? [])
    ) return;
    const { liveWork: _previousWork, ...evidence } = current.evidence;
    const value = {
      ...current,
      evidence: {
        ...evidence,
        descendants,
        ...(liveWork.length ? { liveWork } : {}),
      },
    };
    this.#states.set(entityKey("session", id), value);
    upserts.push(value);
  }
  #descendants(id: string): EntityCounts {
    const sum = own("none", false);
    for (const child of this.family.descendants(id)) {
      if (child === id) continue;
      const counts = this.#own.get(child);
      if (!counts) continue;
      sum.blocked += counts.blocked;
      sum.working += counts.working;
      sum.finished += counts.finished;
      sum.unseen += counts.unseen;
    }
    return sum;
  }
  #helpers(id: string): NonNullable<SessionEvidence["liveWork"]> {
    return [...this.family.descendants(id)].flatMap((child) => {
      if (child === id) return [];
      const value = this.#states.get(entityKey("session", child));
      if (!value?.evidence?.work) return [];
      const metadata = this.family.getMetadata(child);
      const startedAt = value.evidence.liveWork?.find((item) =>
        item.kind === "execution"
      )?.startedAt;
      return [{
        id: child,
        kind: "helper" as const,
        label: "Helper",
        title: metadata?.title ?? child,
        ...(startedAt === undefined ? {} : { startedAt }),
        state: value.state,
      }];
    }).sort((a, b) =>
      (a.startedAt ?? 0) - (b.startedAt ?? 0) || a.id.localeCompare(b.id)
    );
  }
  #session(
    entry: IndexMetadata,
    verdict: Supervision,
    state: ProjectStatus,
    counts: EntityCounts,
    inputs: SessionInputs,
    permissionIDs: readonly string[],
    operation?: "working" | "blocked",
  ): EntityState {
    const activity = entry.activity;
    const cause: BlockedCause | undefined = state !== "blocked"
      ? undefined
      // Immediate causes win over the graced one: grace applies only when a
      // permission is the sole reason.
      : inputs.questions > 0
      ? "question"
      : operation === "blocked"
      ? "operation"
      : failedHelperNeedsAck(entry, verdict.outcome) && verdict.unseen
      ? "failedHelper"
      : verdict.outcome === "failed" && verdict.unseen
      ? "failure"
      : inputs.permissions > 0
      ? "permission"
      : undefined;
    const items = inputs.work
      ? (activity?.work?.items ?? []).filter((item) =>
        activity?.work?.keys.includes(item.id)
      )
      : [];
    const shells: RunningShells["items"] = items.flatMap((item) => {
      if (item.kind !== "shell") return [];
      const { kind: _kind, ...shell } = item;
      return [shell];
    });
    const before = this.#states.get(entityKey("session", entry.id));
    const starts = items.flatMap((item) =>
      item.kind === "execution" && item.startedAt !== undefined
        ? [item.startedAt]
        : []
    );
    const previousRun = before?.evidence?.run;
    const startedAt = starts.length
      ? Math.min(...starts)
      : inputs.work && previousRun?.endedAt !== undefined
      ? undefined
      : previousRun?.startedAt;
    const helpers = this.#helpers(entry.id);
    // Live input and work take priority over a prior unseen run. Roster
    // membership is independent of lamp policy and permission animation.
    const work = inputs.work || operation === "working";
    const opened = this.openedByUser(entry.id);
    const helper = !entry.parentID
      ? undefined
      : inputs.questions > 0 || inputs.permissions > 0 ||
          operation === "blocked"
      ? "needsYou"
      : work
      ? "running"
      : verdict.unseen
      ? "finished"
      : opened
      ? "opened"
      : undefined;
    const evidence: SessionEvidence = {
      ...(verdict.settlement ? { settlement: verdict.settlement } : {}),
      ...(inputs.continuation ? { continuation: true as const } : {}),
      ...(helper ? { helper } : {}),
      ...(helper === "needsYou"
        ? { waitingSince: before?.evidence?.waitingSince ?? Date.now() }
        : {}),
      ...(startedAt === undefined ? {} : {
        run: {
          startedAt,
          ...(!inputs.work && verdict.terminal >= startedAt
            ? { endedAt: verdict.terminal }
            : {}),
        },
      }),
      // A received operation in progress is work on its target session.
      work,
      // Some harnesses publish execution keys without detailed items. Only
      // identities accounted for by the shell roster are excluded.
      ...(inputs.work && (activity?.work?.keys.length ?? 0) > shells.length
        ? { nativeRun: true as const }
        : {}),
      permissions: inputs.permissions,
      questions: inputs.questions,
      descendants: this.#descendants(entry.id),
      requests: {
        permissions: permissionIDs.map((id) => ({ id })),
        questions: inputs.questions > 0
          ? (activity?.inputs?.keys ?? []).map((id) => ({ id }))
          : [],
      },
      ...(items.length > shells.length || helpers.length
        ? {
          liveWork: [
            ...items.flatMap((item) =>
              item.kind === "execution"
                ? [{ ...item, kind: item.kind, state }]
                : []
            ),
            ...helpers,
          ],
        }
        : {}),
      ...(inputs.work && entry.status === "retry" && entry.retry
        ? { retry: { ...entry.retry } }
        : {}),
      ...(verdict.terminalFailure ? { failure: verdict.terminalFailure } : {}),
      // The diagnostic owner already selects current session-level error text.
      // Preserve its marker without interpreting that observation as a run outcome.
      ...(entry.attention.error ? { error: true as const } : {}),
    };
    const dependencies = this.#terminalOwners(entry.id);
    return {
      kind: "session",
      id: entry.id,
      state,
      ...(cause ? { cause } : {}),
      previous: !before
        ? "none"
        : before.state !== state
        ? before.state
        : before.previous,
      counts,
      ...(opened ? { opened: true as const } : {}),
      ...(dependencies ? { dependencies } : {}),
      ...(verdict.terminal ? { terminal: verdict.terminal } : {}),
      ...(verdict.outcome ? { outcome: verdict.outcome } : {}),
      ...(verdict.terminalOrigin
        ? { terminalOrigin: verdict.terminalOrigin }
        : {}),
      evidence,
      shells: shells.length
        ? { items: shells, count: shells.length, state: "working" }
        : noShells,
    };
  }
  #set(value: EntityState): boolean {
    const key = entityKey(value.kind, value.id);
    if (JSON.stringify(this.#states.get(key)) === JSON.stringify(value)) {
      return false;
    }
    this.#states.set(key, value);
    return true;
  }
}
