// SPDX-License-Identifier: LGPL-3.0-only
import {
  archiveEntityID,
  type BlockedCause,
  type EntityCounts,
  entityKey,
  type EntityState,
  type IndexMetadata,
  projectPlacement,
  type ProjectStatus,
  type ProjectSummary,
  rollupStatus,
  type SessionEvidence,
  type Supervision,
} from "@otk/protocol";
import {
  deliveredTerminal,
  failedHelperNeedsAck,
  type SessionSupervision,
} from "./supervision.ts";

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
  graced: number;
  requests: Map<string, number>;
}
/** One session's share of its aggregates. */
interface Contribution {
  counts: EntityCounts;
  graced: number;
  requests: readonly string[];
}
function tally(): Tally {
  return { counts: own("none", false), graced: 0, requests: new Map() };
}
function add(target: Tally, value: Contribution | Tally, sign: 1 | -1): void {
  target.counts.blocked += sign * value.counts.blocked;
  target.counts.working += sign * value.counts.working;
  target.counts.finished += sign * value.counts.finished;
  target.counts.unseen += sign * value.counts.unseen;
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
  #tallies = new Map<string, Tally>();
  #forms = new Map<string, number>();
  #leaves = new Map<string, readonly string[]>();
  #projectsOf = new Map<string, Set<string>>();
  #placement = new Map<
    string,
    Pick<ProjectSummary, "directory" | "archived" | "availability" | "topology">
  >();
  #archiveOf = new Map<string, string>();
  #archiveLeaves = new Map<string, Set<string>>();
  /** D8 task projections borrow the shared identity partition. State changes
   * touch only the groups containing that session. */
  #tasks = new Map<string, Set<string>>();
  #tasksOf = new Map<string, Set<string>>();
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
  ) {}
  get(key: string): EntityState | undefined {
    return this.#states.get(key);
  }
  /** The live keyed map, copied by snapshot assembly like the other maps. */
  values(): Map<string, EntityState> {
    return this.#states;
  }
  /** A new user generation starts without transitions from the previous one. */
  reset(): void {
    this.#states.clear();
    this.#own.clear();
    this.#parents.clear();
    this.#graced.clear();
    this.#checkoutOf.clear();
    this.#tallies.clear();
    this.#forms.clear();
    this.#leaves.clear();
    this.#projectsOf.clear();
    this.#placement.clear();
    this.#archiveOf.clear();
    this.#archiveLeaves.clear();
    this.#tasks.clear();
    this.#tasksOf.clear();
    this.#taskTallies.clear();
    this.#global = tally();
    this.#operations.clear();
    this.#checkoutOperations.clear();
  }
  /** A received operation owned by a project directory (e.g. a creation
   * before its session exists) colours that checkout and its projects. */
  checkoutOperation(directory: string, value?: "working" | "blocked"): void {
    if (value) this.#checkoutOperations.set(directory, value);
    else this.#checkoutOperations.delete(directory);
    const upserts: EntityState[] = [];
    this.#tally(directory);
    this.#checkout(directory, upserts);
    if (upserts.length) this.publish(upserts, []);
  }
  /** Record a session's received-operation input; the caller re-derives it. */
  operation(id: string, value?: "working" | "blocked"): void {
    if (value) this.#operations.set(id, value);
    else this.#operations.delete(id);
  }
  /** Structural membership changes only. No session-state publication scans
   * the catalog or rebuilds the task partition. */
  membership(groups: ReadonlyMap<string, readonly string[]>): void {
    const upserts: EntityState[] = [], removals: string[] = [];
    for (const [id, members] of this.#tasks) {
      if (groups.has(id)) continue;
      for (const member of members) this.#tasksOf.get(member)?.delete(id);
      this.#tasks.delete(id);
      this.#taskTallies.delete(id);
      const key = entityKey("task", id);
      if (this.#states.delete(key)) removals.push(key);
    }
    for (const [id, members] of groups) {
      const previous = this.#tasks.get(id) ?? new Set<string>();
      const next = new Set(members);
      const sum = this.#taskTallies.get(id) ?? tally();
      for (const member of previous) {
        if (next.has(member)) continue;
        add(sum, this.#contribution(member), -1);
        this.#tasksOf.get(member)?.delete(id);
      }
      for (const member of next) {
        if (previous.has(member)) continue;
        add(sum, this.#contribution(member), 1);
        const owners = this.#tasksOf.get(member) ?? new Set<string>();
        owners.add(id);
        this.#tasksOf.set(member, owners);
      }
      this.#tasks.set(id, next);
      this.#taskTallies.set(id, sum);
      const value = this.#aggregate("task", id, sum, 0);
      if (this.#set(value)) upserts.push(value);
    }
    if (upserts.length || removals.length) this.publish(upserts, removals);
  }
  /** S18: the checkout a session belongs to, as placed by ProjectSummaries. */
  member(id: string, checkout?: string): void {
    const before = this.#checkoutOf.get(id);
    if (before === checkout) return;
    const upserts: EntityState[] = [];
    const value = this.#contribution(id);
    if (before) {
      add(this.#tally(before), value, -1);
      this.#checkout(before, upserts);
    }
    if (checkout) {
      this.#checkoutOf.set(id, checkout);
      add(this.#tally(checkout), value, 1);
      this.#checkout(checkout, upserts);
    } else this.#checkoutOf.delete(id);
    if (upserts.length) this.publish(upserts, []);
  }
  /** S21: a checkout's state with its fresh location forms. */
  checkout(directory: string, forms: number): EntityState {
    if (forms) this.#forms.set(directory, forms);
    else this.#forms.delete(directory);
    const upserts: EntityState[] = [];
    this.#tally(directory);
    this.#checkout(directory, upserts);
    if (upserts.length) this.publish(upserts, []);
    return this.#states.get(entityKey("checkout", directory))!;
  }
  /** A project's state over its checkouts (or itself when it has none). */
  project(directory: string, checkouts: readonly string[]): EntityState {
    for (const leaf of this.#leaves.get(directory) ?? []) {
      this.#projectsOf.get(leaf)?.delete(directory);
    }
    this.#leaves.set(directory, [...checkouts]);
    for (const leaf of checkouts) {
      const projects = this.#projectsOf.get(leaf) ?? new Set();
      projects.add(directory);
      this.#projectsOf.set(leaf, projects);
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
    this.#leaves.delete(directory);
    this.#forms.delete(directory);
    if (upserts.length || removals.length) this.publish(upserts, removals);
  }
  /** Interpret one session, publish its state and its ancestors' descendant
   * evidence. Returns the supervision verdict it was derived from. */
  session(
    entry: IndexMetadata,
    acknowledged: number,
    retainedTerminal = 0,
  ): Supervision {
    const verdict = this.supervision.session(
      entry,
      acknowledged,
      retainedTerminal,
    );
    const upserts: EntityState[] = [], removals: string[] = [];
    const contribution = this.#contribution(entry.id);
    const parent = this.#parents.get(entry.id);
    const moved = parent !== entry.parentID;
    if (moved) {
      if (parent) this.#chain(parent, upserts);
      if (entry.parentID) this.#parents.set(entry.id, entry.parentID);
      else this.#parents.delete(entry.id);
    }
    if (entry.deleted) {
      this.#retire(entry.id, removals);
      this.#ancestors(entry.id, upserts);
    } else {
      const operation = this.#operations.get(entry.id);
      const state = rollupStatus(this.supervision.status(verdict), operation);
      const counts = own(state, verdict.unseen === true);
      this.#own.set(entry.id, counts);
      const value = this.#session(entry, verdict, state, counts, operation);
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
    this.#contribute(entry.id, contribution, upserts);
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
    this.#contribute(id, contribution, upserts);
    if (upserts.length || removals.length) this.publish(upserts, removals);
  }
  #contribution(id: string): Contribution {
    const counts = this.#own.get(id);
    return {
      counts: counts ? { ...counts } : own("none", false),
      graced: this.#graced.has(id) ? 1 : 0,
      requests: this.#graced.get(id) ?? [],
    };
  }
  /** Apply one session's changed contribution to its checkout, the projects
   * holding that checkout and the global entity; nothing else is visited. */
  #contribute(
    id: string,
    before: Contribution,
    upserts: EntityState[],
  ): void {
    const after = this.#contribution(id);
    if (JSON.stringify(before) === JSON.stringify(after)) return;
    for (const task of this.#tasksOf.get(id) ?? []) {
      const sum = this.#taskTallies.get(task)!;
      add(sum, before, -1);
      add(sum, after, 1);
      const value = this.#aggregate("task", task, sum, 0);
      if (this.#set(value)) upserts.push(value);
    }
    const checkout = this.#checkoutOf.get(id);
    if (checkout) {
      add(this.#tally(checkout), before, -1);
      add(this.#tally(checkout), after, 1);
      this.#checkout(checkout, upserts);
    }
    add(this.#global, before, -1);
    add(this.#global, after, 1);
    const value = this.#aggregate("global", "global", this.#global, 0);
    if (this.#set(value)) upserts.push(value);
  }
  #tally(directory: string): Tally {
    let value = this.#tallies.get(directory);
    if (!value) this.#tallies.set(directory, value = tally());
    return value;
  }
  #checkout(directory: string, upserts: EntityState[]): void {
    const value = this.#aggregate(
      "checkout",
      directory,
      this.#tally(directory),
      this.#forms.get(directory) ?? 0,
      this.#checkoutOperations.get(directory),
    );
    if (this.#set(value)) upserts.push(value);
    this.#placeArchive(directory, upserts);
    for (const project of this.#projectsOf.get(directory) ?? []) {
      this.#project(project, upserts);
    }
  }
  #project(directory: string, upserts: EntityState[]): void {
    const sum = tally();
    let forms = 0;
    const operations: ("working" | "blocked")[] = [];
    for (const leaf of this.#leaves.get(directory) ?? [directory]) {
      const value = this.#tallies.get(leaf);
      if (value) add(sum, value, 1);
      forms += this.#forms.get(leaf) ?? 0;
      const operation = this.#checkoutOperations.get(leaf);
      if (operation) operations.push(operation);
    }
    const operation = rollupStatus(...operations);
    const value = this.#aggregate(
      "project",
      directory,
      sum,
      forms,
      operation === "none" ? undefined : operation as "working" | "blocked",
    );
    if (this.#set(value)) upserts.push(value);
  }
  /** C3 placement is shared unchanged with the client. A checkout state change
   * revisits only its old/new archive, never the session population. */
  #placeArchive(directory: string, upserts: EntityState[]): void {
    const facts = this.#placement.get(directory),
      before = this.#archiveOf.get(directory);
    const status = this.#states.get(entityKey("checkout", directory))?.state ??
      "none";
    const next = facts &&
        projectPlacement({
            lifecycle: facts,
            status,
            inactive: false,
            hasSessions: false,
          }).section === "archived"
      ? archiveEntityID(facts)
      : undefined;
    if (before && before !== next) {
      this.#archiveLeaves.get(before)?.delete(directory);
      this.#archiveOf.delete(directory);
    }
    if (next) {
      const leaves = this.#archiveLeaves.get(next) ?? new Set<string>();
      leaves.add(directory);
      this.#archiveLeaves.set(next, leaves);
      this.#archiveOf.set(directory, next);
    }
    for (const id of new Set([before, next])) {
      if (!id) continue;
      const sum = tally();
      let forms = 0;
      for (const leaf of this.#archiveLeaves.get(id) ?? []) {
        add(sum, this.#tally(leaf), 1);
        forms += this.#forms.get(leaf) ?? 0;
      }
      const value = this.#aggregate("archive", id, sum, forms);
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
  ): EntityState {
    const { counts } = members;
    const state = rollupStatus(
      counts.blocked || forms ? "blocked" : undefined,
      operation,
      counts.working ? "working" : undefined,
      counts.finished ? "finished" : undefined,
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
      ...(cause === "permission"
        ? {
          requests: [...members.requests.keys()].sort().map((id) => ({ id })),
        }
        : {}),
    };
  }
  #retire(id: string, removals: string[]): void {
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
    operation?: "working" | "blocked",
  ): EntityState {
    const inputs = this.supervision.inputs(entry);
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
    const evidence: SessionEvidence = {
      awaitingDelivery: !!entry.parentID &&
        verdict.terminal > deliveredTerminal(entry),
      ...(startedAt === undefined ? {} : {
        run: {
          startedAt,
          ...(!inputs.work && verdict.terminal >= startedAt
            ? { endedAt: verdict.terminal }
            : {}),
        },
      }),
      // A received operation in progress is work on its target session.
      work: inputs.work || operation === "working",
      permissions: inputs.permissions,
      questions: inputs.questions,
      descendants: this.#descendants(entry.id),
      requests: {
        permissions: inputs.permissions > 0
          ? (activity?.permissions?.keys ?? []).map((id) => ({ id }))
          : [],
        questions: inputs.questions > 0
          ? (activity?.inputs?.keys ?? []).map((id) => ({ id }))
          : [],
      },
      ...(items.length || helpers.length
        ? {
          liveWork: [
            ...items.map((item) => ({
              id: item.id,
              kind: item.kind,
              label: item.label,
              title: item.title,
              ...(item.startedAt === undefined
                ? {}
                : { startedAt: item.startedAt }),
              state,
            })),
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
      ...(verdict.terminal ? { terminal: verdict.terminal } : {}),
      ...(verdict.outcome ? { outcome: verdict.outcome } : {}),
      ...(verdict.terminalOrigin
        ? { terminalOrigin: verdict.terminalOrigin }
        : {}),
      evidence,
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
