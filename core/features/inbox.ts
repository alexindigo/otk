// SPDX-License-Identifier: LGPL-3.0-only
import {
  type AcknowledgeScope,
  entityKey,
  entityRequiresVisibility,
  type EntityState,
  errorMessage,
  type InboxBaseline,
  type InboxOp,
  type InboxSnapshot,
  type IndexEntry,
  type IndexMetadata,
  isSessionID,
  type ProjectMove,
  type ProjectRecord,
  type ProjectSummary,
  type ServerFrame,
  taskEntityID,
  type TaskRecord,
  type ViewLease,
} from "@otk/protocol";
import { HarnessError } from "@otk/harness";
import type {
  Checkouts,
  Finishes,
  Projects,
  ProjectTemplates,
  Seen,
  StoreWrite,
  Tasks,
} from "@otk/store";
import { ProjectOrderStore } from "@otk/store";
import type { IndexStore } from "../index/store.ts";
import { ProjectSummaries } from "../index/project-summaries.ts";
import { SessionSupervision } from "../index/supervision.ts";
import { EntityStates } from "../index/entity-states.ts";
import { ProjectIdentity } from "../index/project-identity.ts";
import { ProjectOrder } from "./project-order.ts";
import type { FrameSource } from "../ws/connections.ts";
import type { RpcRegistry } from "../ws/registry.ts";
import { sessionID, text } from "../ws/params.ts";
import { pathTemplate, projectPath, scanProjects } from "./project-scan.ts";
import {
  localExecution,
  localResultExecution,
  localWrite,
  metadataReceipt,
  nativeEffect,
  nativeExecution,
  preparedLocalExecution,
  readExecution,
} from "../requests/policies.ts";
import {
  acknowledgeReceipt,
  closedReceipt,
  projectReceipt,
  projectSessionReceipt,
  seenReceipt,
  taskReceipt,
  tasksReceipt,
  templatesReceipt,
  visitReceipt,
} from "./inbox-receipts.ts";
import { createdReceipt } from "./session-receipts.ts";
import type { ContentSession } from "@otk/protocol";
import type { RpcContext } from "../ws/registry.ts";
import type {
  TerminalChange,
  TerminalTracking,
} from "../terminals/tracking.ts";
export interface InboxStores {
  projects: Projects;
  tasks: Tasks;
  seen: Seen;
  finishes: Finishes;
  templates: ProjectTemplates;
  checkouts?: Checkouts;
}
const orderMoveReceipt = metadataReceipt("project-order-move", (value) => {
  if (value !== true) throw new TypeError("Invalid project move receipt");
  return true;
});
/** A received operation's target: its session, or its project directory. */
interface OperationTarget {
  kind: "session" | "directory";
  id: string;
}
interface InboxMaps {
  entities: Map<string, EntityState>;
  summaries: Map<string, ProjectSummary>;
  projects: Map<string, ProjectRecord>;
  tasks: Map<string, TaskRecord>;
  seen: Map<string, number>;
  finishes: Map<string, number>;
}
interface InboxAssembly {
  dirty: Map<string, { kind: keyof InboxMaps; id: string }>;
  overflow: boolean;
}
interface InboxPublication {
  value: InboxOp;
  directory?: string;
  sessionID?: string;
  taskID?: string;
}
/** Application-owned metadata only; the index remains the sole session owner. */
export class InboxFeature implements FrameSource {
  #taskScopes = new Map<string, () => ViewLease>();
  #rootsScheduled = false;
  #taskRoots(): void {
    if (this.#rootsScheduled) return;
    this.#rootsScheduled = true;
    queueMicrotask(() => {
      this.#rootsScheduled = false;
      if (this.#closed) return;
      const roots = new Map<string, string>();
      for (const task of this.#tasks.values()) {
        for (const id of task.sessions) {
          const entry = this.index.snapshotEntry(id);
          if (entry && !entry.parentID && !entry.deleted) {
            roots.set(id, taskEntityID("task", task.id));
          }
        }
      }
      this.states.roots(roots);
    });
  }
  #taskProjects = new Map<string, readonly TaskRecord[]>();
  *#listedTasks(view: ViewLease): Iterable<string> {
    const directory = this.#directory(view);
    if (!directory) return;
    for (
      const scope of this.summaries.values.get(directory)?.scopes ?? [directory]
    ) {
      yield* this.states.listed(this.summaries.leaf(scope));
    }
  }
  #projectTasks(
    directory: string,
    followParent = false,
  ): readonly TaskRecord[] {
    const listed = new Set(
      this.#listedTasks({ directory, epoch: 0, crumbs: [], rows: [] }),
    );
    if (followParent) {
      const scopes = this.summaries.values.get(directory)?.scopes ??
        [directory];
      const inherited = new Set(
        scopes.flatMap((scope) =>
          this.index.catalog(scope).flatMap((entry) =>
            this.index.hierarchy.node(entry.id, true)?.taskID ?? []
          )
        ),
      );
      return [...this.#tasks.values()].filter((task) =>
        scopes.includes(task.directory) || inherited.has(task.id) ||
        listed.has(taskEntityID("task", task.id))
      );
    }
    let value = this.#taskProjects.get(directory);
    if (!value) {
      value = [...this.#tasks.values()].filter((task) =>
        (this.summaries.values.get(directory)?.scopes ?? [directory]).includes(
          task.directory,
        )
      );
      this.#taskProjects.set(directory, value);
    }
    const local = new Set(value.map((task) => task.id));
    return [
      ...value,
      ...[...listed].flatMap((identity) => {
        if (!identity.startsWith("task/")) return [];
        const id = identity.slice("task/".length), task = this.#tasks.get(id);
        return task && !local.has(id) ? [task] : [];
      }),
    ];
  }
  #invalidateTasks(scope: string): void {
    for (const directory of this.#taskProjects.keys()) {
      if (
        (this.summaries.values.get(directory)?.scopes ?? [directory]).includes(
          scope,
        )
      ) this.#taskProjects.delete(directory);
    }
  }
  #views = new Map<string, () => InboxBaseline>();
  retained(): readonly string[] {
    return [
      ...new Set([
        ...[...this.#finishes].filter(([id]) => this.#unseen(id, this.user))
          .map(([id]) => id),
        ...this.#terminalSource?.counts.sessions.keys() ?? [],
      ]),
    ];
  }
  #unseen(id: string, user: string): boolean {
    const entry = this.index.getMetadata(id);
    // Before native hydration, retained history remains conservatively unseen.
    return this.supervision.session(
      entry ?? {
        id,
        directory: "",
        projectID: "",
        title: "",
        archived: false,
        timeCreated: 0,
        timeUpdated: 0,
        status: "idle",
        attention: {
          permissions: 0,
          questions: 0,
          childPermissions: 0,
          childQuestions: 0,
        },
      },
      this.#seen.get(user)?.get(id) ?? 0,
      this.#finishes.get(id) ?? 0,
    ).unseen === true;
  }
  #directory(view: ViewLease): string | undefined {
    return view.directory ??
      (view.selected
        ? this.index.getMetadata(view.selected)?.directory
        : undefined);
  }
  keys(view: ViewLease): string[] {
    const directory = this.#directory(view);
    if (!directory) return [];
    const ids = new Set<string>();
    // Mandatory family attention follows native ancestry across checkout scopes,
    // independently of checkout-local task membership. These are scalar leases.
    if (view.selected) {
      for (const id of this.index.descendants(view.selected)) {
        const entry = this.index.getMetadata(id);
        if (
          id !== view.selected && !entry?.deleted &&
          entityRequiresVisibility(this.states.get(entityKey("session", id)))
        ) ids.add(id);
      }
    }
    for (const task of this.#projectTasks(directory, view.tasksFollowParent)) {
      for (const id of task.sessions) ids.add(id);
    }
    for (
      const scope of this.summaries.values.get(directory)?.scopes ?? [directory]
    ) {
      for (const id of this.#terminalSource?.owners(scope) ?? []) {
        if (!this.index.getMetadata(id)?.deleted) ids.add(id);
      }
    }
    for (
      const entry
        of (this.summaries.values.get(directory)?.scopes ?? [directory])
          .flatMap((scope) => this.index.catalog(scope))
    ) {
      if (entry.deleted) continue;
      if (
        entityRequiresVisibility(
          this.states.get(entityKey("session", entry.id)),
        )
      ) {
        ids.add(entry.id);
      }
    }
    return [...ids];
  }
  project(entry: IndexEntry, view: ViewLease): IndexEntry {
    return {
      ...entry,
      hierarchy: this.index.hierarchy.node(entry.id, view.tasksFollowParent),
    };
  }
  #sessionForView(id: string, selected?: string): EntityState | undefined {
    const value = this.states.get(entityKey("session", id));
    return value && id === selected
      ? { ...value, composerLink: this.states.composerLink(id) }
      : value;
  }
  open(
    view: () => ViewLease,
    id: string,
    entries: () => ReadonlySet<string>,
  ): FrameSource {
    this.#taskScopes.set(id, view);
    const listeners = new Set<(frame: ServerFrame) => void>();
    let revision = 0;
    let deliveredTasks = new Map<string, TaskRecord>();
    let deliveredTaskStates = new Map<string, EntityState>();
    let deliveredListing = this.states.listingRevision;
    const reconcileTaskStates = (): InboxOp[] => {
      if (!delivered) return [];
      const ops: InboxOp[] = [], next = new Map<string, EntityState>();
      for (const id of this.#listedTasks(view())) {
        const key = entityKey("task", id);
        const value = this.states.get(key);
        if (!value || next.has(key)) continue;
        next.set(key, value);
        if (value !== deliveredTaskStates.get(key)) {
          ops.push({ op: "entity.upsert", value });
        }
      }
      for (const key of deliveredTaskStates.keys()) {
        if (!next.has(key)) ops.push({ op: "entity.remove", key });
      }
      deliveredTaskStates = next;
      deliveredListing = this.states.listingRevision;
      return ops;
    };
    type Facts = {
      seen?: number;
      finish?: number;

      entity?: EntityState;
    };
    let delivered: Map<string, Facts> | undefined;
    const facts = (id: string): Facts => ({
      seen: this.#seen.get(this.user)?.get(id),
      finish: this.#finishes.get(id),

      entity: this.#sessionForView(id, view().selected),
    });
    // Facts follow lease admission. Each pass compares only the sessions it
    // names, so work stays proportional to changed rows, not to the lease.
    const reconcileSessions = (
      ids: Iterable<string>,
      leased: ReadonlySet<string>,
    ): InboxOp[] => {
      if (!delivered) return [];
      const ops: InboxOp[] = [];
      for (const id of ids) {
        if (!leased.has(id)) {
          delivered.delete(id);
          continue;
        }
        const before = delivered.get(id), current = facts(id);
        if (current.seen !== undefined && current.seen !== before?.seen) {
          ops.push({ op: "seen", sessionID: id, time: current.seen });
        }
        if (current.finish !== undefined && current.finish !== before?.finish) {
          ops.push({ op: "finish", sessionID: id, time: current.finish });
        }
        if (JSON.stringify(current.entity) !== JSON.stringify(before?.entity)) {
          ops.push(
            current.entity
              ? { op: "entity.upsert", value: current.entity }
              : { op: "entity.remove", key: entityKey("session", id) },
          );
        }
        delivered.set(id, current);
      }
      return ops;
    };
    const reconcileTasks = (): InboxOp[] => {
      if (!delivered) return [];
      const ops: InboxOp[] = [];
      const scope = view(), directory = this.#directory(scope);
      const tasks = new Map(
        (directory
          ? this.#projectTasks(directory, scope.tasksFollowParent)
          : []).map((task) => [task.id, task]),
      );
      for (const id of deliveredTasks.keys()) {
        if (!tasks.has(id)) ops.push({ op: "task.remove", id });
      }
      for (const [id, task] of tasks) {
        if (JSON.stringify(deliveredTasks.get(id)) !== JSON.stringify(task)) {
          ops.push({ op: "task.upsert", task: structuredClone(task) });
        }
      }
      deliveredTasks = new Map(
        [...tasks].map(([id, task]) => [id, structuredClone(task)]),
      );
      return ops;
    };
    const emit = (frame: ServerFrame) => {
      for (const listener of listeners) listener(frame);
    };
    const emitOps = (ops: InboxOp[], admitted = false) => {
      if (!ops.length) return;
      const from = revision;
      revision += ops.length;
      emit({
        t: "inbox.patch",
        generation: this.#generation,
        from,
        revision,
        ops,
        ...(admitted ? { admitted: true as const } : {}),
      });
    };
    const baseline = (): InboxBaseline => {
      this.#flush();
      const inbox = this.get(view(), entries());
      deliveredTasks = new Map(
        inbox.tasks.map((task) => [task.id, structuredClone(task)]),
      );
      deliveredTaskStates = new Map(
        Object.entries(inbox.entities ?? {}).filter(([, value]) =>
          value.kind === "task"
        ),
      );
      deliveredListing = this.states.listingRevision;
      delivered = new Map([...entries()].map((id) => [id, {
        seen: inbox.seen[id],
        finish: inbox.finishes[id],

        entity: inbox.entities?.[entityKey("session", id)],
      }]));
      return {
        generation: this.#generation,
        revision,
        epoch: view().epoch,
        summaryRevision: this.#summaryRevision,
        inbox,
      };
    };
    this.#views.set(id, baseline);
    const stop = this.listen((frame) => {
      if (frame.t !== "inbox.patch") emit(frame);
    });
    const publish = (changes: readonly InboxPublication[]) => {
      if (!delivered) return;
      const scope = view(),
        directory = this.#directory(scope);
      const ops = changes.filter((change) =>
        change.sessionID === undefined && change.taskID === undefined
      )
        .filter((change) =>
          change.directory !== undefined
            ? directory !== undefined &&
              (this.summaries.values.get(directory)?.scopes ?? [directory])
                .includes(change.directory)
            : true
        ).map((change) => change.value).filter((op) =>
          !(op.op === "entity.upsert" && op.value.kind === "task") &&
          !(op.op === "entity.remove" &&
            op.key.startsWith(entityKey("task", "")))
        );
      const listingChanged = deliveredListing !== this.states.listingRevision;
      for (const { value } of listingChanged ? [] : changes) {
        if (value.op !== "entity.upsert" || value.value.kind !== "task") {
          continue;
        }
        const key = entityKey("task", value.value.id);
        if (!deliveredTaskStates.has(key)) continue;
        deliveredTaskStates.set(key, value.value);
        ops.push(value);
      }
      const sessions = new Set(
        changes.flatMap((change) =>
          change.sessionID === undefined ? [] : [change.sessionID]
        ),
      );
      if (
        scope.selected &&
        (listingChanged ||
          changes.some(({ value }) =>
            value.op === "entity.upsert" && value.value.kind === "task" ||
            value.op === "entity.remove" && value.key.startsWith("task:")
          ))
      ) sessions.add(scope.selected);
      // Task projection can scan the scope's catalog, so it runs only when a
      // task itself changed, never for every publication.
      emitOps([
        ...ops,
        ...reconcileSessions(sessions, entries()),
        ...(listingChanged ||
            changes.some((change) => change.taskID !== undefined)
          ? reconcileTasks()
          : []),
        ...(listingChanged ? reconcileTaskStates() : []),
      ]);
    };
    this.#publications.add(publish);
    // One coalesced pass per microtask, sized to what changed: the index view
    // names the rows a patch admits or retires, view and topology changes
    // re-project tasks, and only a lease snapshot reconciles the whole lease.
    let entriesScheduled = false, wholeLease = false, taskTopology = false;
    const named = new Set<string>();
    const schedule = () => {
      if (entriesScheduled) return;
      entriesScheduled = true;
      queueMicrotask(() => {
        entriesScheduled = false;
        const whole = wholeLease, tasksOnly = taskTopology, ids = [...named];
        wholeLease = taskTopology = false;
        named.clear();
        if (!this.#views.has(id)) return;
        // Publish queued live changes before reading known admission facts.
        this.#flush();
        // Facts for newly leased rows are known state, not new events.
        if (whole) {
          const leased = entries();
          for (const id of delivered?.keys() ?? []) {
            if (!leased.has(id)) delivered?.delete(id);
          }
          emitOps(reconcileSessions(leased, leased), true);
        } else emitOps(reconcileSessions(ids, entries()), true);
        if (whole || tasksOnly) {
          emitOps([...reconcileTasks(), ...reconcileTaskStates()]);
        }
      });
    };
    const entriesChanged = (rows?: readonly string[]) => {
      if (!delivered) return;
      if (rows) {
        if (!rows.length) return;
        for (const row of rows) named.add(row);
      } else wholeLease = true;
      schedule();
    };
    const topologyChanged = () => {
      if (!delivered) return;
      taskTopology = true;
      schedule();
    };
    let rowsScheduled = false;
    const rowsChanged = () => {
      if (rowsScheduled) return;
      rowsScheduled = true;
      const directory = this.#directory(view());
      queueMicrotask(() => {
        rowsScheduled = false;
        if (
          directory && this.#views.has(id) &&
          directory === this.#directory(view())
        ) {
          emit({ t: "sessions.changed", directory });
        }
      });
    };
    const stopRows = this.index.observe((entry, previous, delta) => {
      if (delta) return;
      const directory = this.#directory(view());
      const scopes = this.summaries.values.get(directory ?? "")?.scopes ??
        (directory ? [directory] : []);
      const local = scopes.some((scope) =>
        entry.directory === scope || previous?.directory === scope
      );
      // Lease membership arrives as index frames. Only a parent link or a
      // moved, re-projected or deleted row can move inherited task
      // membership; those re-project tasks without scanning the lease.
      if (
        (!previous || entry.parentID !== previous.parentID ||
          entry.directory !== previous.directory ||
          entry.projectID !== previous.projectID ||
          JSON.stringify(entry.deleted) !== JSON.stringify(previous.deleted))
      ) topologyChanged();
      if (!local) return;
      if (
        !previous || entry.title !== previous.title ||
        entry.parentID !== previous.parentID ||
        entry.directory !== previous.directory ||
        entry.timeUpdated !== previous.timeUpdated ||
        JSON.stringify(entry.deleted) !== JSON.stringify(previous.deleted)
      ) rowsChanged();
    });
    const stopRemoval = this.index.observeRemoval(() => {
      topologyChanged();
      rowsChanged();
    });
    // Cached page structures carry task ownership too. Reproject a demanded
    // page after membership changes, through the existing list resource owner.
    const stopTasks = this.stores.tasks.listen(rowsChanged);
    const hydrate = async (signal?: AbortSignal) => {
      const scope = view();
      const keys = [
        ...new Set([
          ...this.keys(scope),
          ...scope.crumbs,
          ...scope.rows,
          ...(scope.selected ? [scope.selected] : []),
        ]),
      ];
      if (keys.length) await this.hydrate?.(keys, signal);
    };
    return {
      entriesChanged,
      // A view change re-projects tasks; rows it admits arrive as frames.
      viewChanged: topologyChanged,
      snapshot: async (signal) => {
        await hydrate(signal);
        const value = baseline();
        return { t: "inbox.snapshot", ...value };
      },
      listen: (listener) => {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
      close: () => {
        delivered = undefined;
        deliveredTasks.clear();
        deliveredTaskStates.clear();
        stop();
        this.#publications.delete(publish);
        stopRows();
        stopRemoval();
        stopTasks();
        listeners.clear();
        this.#views.delete(id);
        this.#taskScopes.delete(id);
      },
    };
  }
  #listeners = new Set<(frame: ServerFrame) => void>();
  #publications = new Set<(changes: readonly InboxPublication[]) => void>();
  #stops: (() => void)[] = [];
  #scheduled = false;
  #generation = crypto.randomUUID();
  #revision = 0;
  #pending = new Map<string, InboxPublication>();
  #summaryPending = new Map<string, ProjectSummary | null>();
  #summaryRevision = 0;
  #projects = new Map<string, ProjectRecord>();
  #tasks = new Map<string, TaskRecord>();
  #templates: string[] = [];
  #closed = false;
  #discovered: string[] = [];
  #discoveryError = "";
  #scanVersion = 0;
  #policies: ReturnType<Projects["policies"]> = [];
  #seen = new Map<string, Map<string, number>>();
  #finishes = new Map<string, number>();
  readonly supervision = new SessionSupervision();
  #terminalSource?: Pick<TerminalTracking, "counts" | "listen" | "owners">;
  #dependencyOwners = new Set<string>();
  #dependencyTask?: Promise<void>;
  #dependencyAbort = new AbortController();
  terminalDependencies(
    source: Pick<TerminalTracking, "counts" | "listen" | "owners">,
  ): void {
    this.#terminalSource = source;
    this.states.terminalOwners((id) => source.counts.sessions.get(id) ?? 0);
    const changed = (change: TerminalChange) => {
      if (this.#closed || this.#dependencyAbort.signal.aborted) return;
      if (change.changedCheckouts.length) {
        this.summaries.terminalDependencies(change.checkouts);
      }
      for (const id of change.changedSessions) this.#dependencyOwners.add(id);
      if (this.#dependencyTask) return;
      this.#dependencyTask = Promise.resolve().then(async () => {
        const signal = this.#dependencyAbort.signal;
        while (
          this.#dependencyOwners.size && !this.#closed && !signal.aborted
        ) {
          const ids = [...this.#dependencyOwners].slice(
            0,
            this.snapshotRows ?? 128,
          );
          for (const id of ids) this.#dependencyOwners.delete(id);
          const missing = ids.filter((id) =>
            !this.index.getMetadata(id) && source.counts.sessions.has(id)
          );
          if (missing.length) {
            try {
              await this.hydrate?.(missing, signal);
            } catch (cause) {
              if (!signal.aborted) {
                console.error("Terminal owner hydration failed", cause);
              }
            }
          }
          if (this.#closed || signal.aborted) {
            return;
          }
          for (const id of ids) {
            const entry = this.index.getMetadata(id);
            if (entry) this.#observe(entry, entry);
            this.summaries.mark(id);
          }
          if (this.#dependencyOwners.size) {
            await new Promise<void>((resolve) => setTimeout(resolve, 0));
          }
        }
      }).catch((cause) => {
        if (!this.#dependencyAbort.signal.aborted) {
          console.error("Terminal owner hydration failed", cause);
        }
      }).finally(() => {
        this.#dependencyTask = undefined;
        if (
          this.#dependencyOwners.size && !this.#closed &&
          !this.#dependencyAbort.signal.aborted
        ) {
          changed({
            ...source.counts,
            changedSessions: [],
            changedCheckouts: [],
          });
        }
      });
    };
    this.#stops.push(source.listen(changed));
    changed({
      ...source.counts,
      changedSessions: [...source.counts.sessions.keys()],
      changedCheckouts: [...source.counts.checkouts.keys()],
    });
  }
  async stopDependencies(): Promise<void> {
    this.#dependencyAbort.abort();
    this.#dependencyOwners.clear();
    await this.#dependencyTask;
  }
  /** Borrow the same per-user evidence projection as lamps and mandatory tabs. */
  navigationStatus(id: string): import("@otk/protocol").ProjectStatus {
    this.#identity();
    const value = this.states.get(entityKey("session", id));
    return value && value.state !== "none"
      ? value.state
      : value?.dependencies
      ? "dependencies"
      : "none";
  }
  /** Session entities follow the view lease like the facts they replace. */
  #entities(
    upserts: readonly EntityState[],
    removals: readonly string[],
  ): void {
    for (const value of upserts) {
      const key = entityKey(value.kind, value.id);
      this.#capture("entities", key);
      this.#queue(
        `entity:${key}`,
        { op: "entity.upsert", value },
        value.kind === "session" ? { sessionID: value.id } : {},
      );
    }
    const session = entityKey("session", "");
    for (const key of removals) {
      this.#capture("entities", key);
      this.#queue(
        `entity:${key}`,
        { op: "entity.remove", key },
        key.startsWith(session) ? { sessionID: key.slice(session.length) } : {},
      );
    }
  }
  #assemblies = new Set<InboxAssembly>();
  #user = "";
  readonly states: EntityStates;
  readonly summaries: ProjectSummaries;
  readonly projectOrder: ProjectOrder;
  constructor(
    readonly stores: InboxStores,
    readonly index: IndexStore,
    readonly identity: string | (() => string),
    readonly scan: (templates: readonly string[]) => Promise<string[]> =
      scanProjects,
    readonly promote?: (sessionID: string) => void,
    readonly snapshotRows?: number,
    readonly snapshotPending?: number,
    readonly hydrate?: (
      ids: readonly string[],
      signal?: AbortSignal,
    ) => Promise<void>,
    readonly discoveryProject?: (directory: string, active: boolean) => void,
    entityClock?: EntityStates["clock"],
  ) {
    this.states = new EntityStates(
      this.supervision,
      index,
      (upserts, removals) => this.#entities(upserts, removals),
      entityClock,
      (id) => {
        const entry = this.index.getMetadata(id);
        if (!entry) return;
        this.#observe(entry);
        this.summaries.mark(id);
      },
    );
    const identityOwner = new ProjectIdentity(stores.checkouts);
    this.projectOrder = new ProjectOrder(
      new ProjectOrderStore(stores.projects.db),
      identityOwner,
    );
    this.#identity();
    this.#tasks = new Map(stores.tasks.list().map((task) => [task.id, task]));
    this.#templates = stores.templates.list();
    this.#policies = stores.projects.policies();
    this.#finishes = new Map(Object.entries(stores.finishes.tokens()));
    for (const { user, session, time } of stores.seen.tokens()) {
      const marks = this.#seen.get(user) ?? new Map<string, number>();
      marks.set(session, time);
      this.#seen.set(user, marks);
    }
    this.summaries = new ProjectSummaries(
      (id) => ({
        seen: this.#seen.get(this.user)?.get(id) ?? 0,
        finish: this.#finishes.get(id) ?? 0,
      }),
      (summary) => {
        this.#taskProjects.delete(summary.directory);
        this.#discoveryProject(summary.directory, summary);
        this.#capture("summaries", summary.directory);
        this.#summaryPending.set(summary.directory, summary);
        this.#schedule();
      },
      (directory) => {
        this.#capture("summaries", directory);
        this.#summaryPending.set(directory, null);
        this.#schedule();
      },
      this.supervision,
      identityOwner,
      this.index.hierarchy,
      this.states,
      undefined,
      (directories, revised) =>
        this.projectOrder.admit(this.user, directories, revised),
    );
    this.index.hierarchy.configure(
      this.summaries.identity,
      () => [...this.#tasks.values()],
      (id) =>
        entityRequiresVisibility(this.states.get(entityKey("session", id))),
    );
    for (const project of this.#projects.values()) {
      this.summaries.ensure(project.directory);
    }
    for (const entry of index.snapshotEntries()) {
      const { digest: _digest, ...metadata } = entry;
      this.summaries.entry(metadata);
    }
    this.projectOrder.admit(
      this.user,
      [...index.snapshotEntries()].map((entry) => entry.directory),
    );
    this.#stops.push(
      index.observeDirectories((directories) =>
        this.projectOrder.admit(this.user, directories)
      ),
      index.observe((entry, previous, delta) => {
        if (
          delta &&
          JSON.stringify(entry.deleted) === JSON.stringify(previous?.deleted)
        ) return;
        this.#observe(entry, previous);
        const { digest: _digest, ...metadata } = entry;
        for (const affected of this.summaries.entry(metadata)) {
          // The same activity now belongs to its revised checkout projection.
          this.#observe(affected, affected);
        }
        if (previous && entry.parentID !== previous.parentID) {
          this.summaries.refresh();
        }
        if (
          !previous || entry.parentID !== previous.parentID ||
          JSON.stringify(entry.deleted) !== JSON.stringify(previous.deleted)
        ) {
          this.#taskRoots();
        }
      }),
      index.observeRemoval((id) => {
        this.summaries.remove(id);
        this.#taskRoots();
      }),
      index.observeAuthority((value) => {
        this.summaries.authority(value);
      }),
      index.observeSeeds((values) => {
        for (const entry of this.summaries.seed(values)) this.#observe(entry);
        this.index.hierarchy.invalidate();
        this.#taskRoots();
      }),
      stores.projects.listen((change) => {
        this.#identity();
        this.projectOrder.admit(
          change.user,
          change.upsert.map((project) => project.directory),
        );
        for (const project of change.upsert) {
          this.summaries.ensure(project.directory);
          const known = this.#policies.find((policy) =>
            policy.user === change.user &&
            policy.directory === project.directory
          );
          if (known) known.inactive = project.inactive;
          else {this.#policies.push({
              user: change.user,
              directory: project.directory,
              inactive: project.inactive,
            });}
          if (change.user === this.#user) {
            this.#projects.set(project.directory, project);
            this.#discoveryProject(project.directory);
            this.#capture("projects", project.directory);
            this.#queue(`project:${project.directory}`, {
              op: "project.upsert",
              project,
            });
          }
        }
        for (const directory of change.remove) {
          this.#policies = this.#policies.filter((p) =>
            p.user !== change.user || p.directory !== directory
          );
          if (change.user === this.#user) {
            this.#projects.delete(directory);
            this.#discoveryProject(directory);
            this.#capture("projects", directory);
            this.#queue(`project:${directory}`, {
              op: "project.remove",
              directory,
            });
          }
        }
        this.#summaryDirectories();
      }),
      stores.finishes.listen(({ session, time, terminal }) => {
        if (terminal === undefined) return;
        this.#finishes.set(session, time);
        this.summaries.mark(session);
        this.#capture("finishes", session);
        this.#queue(`finish:${session}`, {
          op: "finish",
          sessionID: session,
          time,
        }, { sessionID: session });
      }),
      stores.seen.listen(({ user, session, time, terminal }) => {
        if (terminal === undefined) return;
        this.#identity();
        const marks = this.#seen.get(user) ?? new Map<string, number>();
        marks.set(session, time);
        this.#seen.set(user, marks);
        if (user === this.user) {
          this.summaries.mark(session);
          this.#capture("seen", session);
          this.#queue(`seen:${session}`, {
            op: "seen",
            sessionID: session,
            time,
          }, { sessionID: session });
        }
      }),
      stores.tasks.listen((change) => {
        this.index.hierarchy.invalidate();
        for (const task of change.upsert) {
          this.#invalidateTasks(task.directory);
          this.#tasks.set(task.id, task);
          this.#capture("tasks", task.id);
          this.#queue(`task:${task.id}`, { op: "task.upsert", task }, {
            directory: task.directory,
            taskID: task.id,
          });
        }
        for (const id of change.remove) {
          const task = this.#tasks.get(id);
          if (task) this.#invalidateTasks(task.directory);
          this.#tasks.delete(id);
          this.#capture("tasks", id);
          this.#queue(`task:${id}`, { op: "task.remove", id }, {
            directory: task?.directory ?? "",
            taskID: id,
          });
        }
        this.#taskRoots();
      }),
      stores.templates.listen(({ templates }) => {
        this.#templates = templates;
        this.#queue("templates", { op: "templates", values: templates });
        void this.#scan();
      }),
    );
    for (const entry of index.snapshotEntries()) this.#observe(entry);
    this.#taskRoots();
    void this.#scan();
  }
  #discoveryProject(
    directory: string,
    summary = this.summaries?.values.get(directory),
  ): void {
    const active = !!(summary?.hasSessions || summary?.locationForms ||
      summary?.dependencies) &&
      (!this.#projects.get(directory)?.inactive ||
        summary.status === "working" || summary.status === "blocked" ||
        summary.status === "dependencies" ||
        (summary.unseenCount ?? 0) > 0);
    this.discoveryProject?.(directory, active);
  }
  get user(): string {
    return typeof this.identity === "string" ? this.identity : this.identity();
  }
  approvalAttention(
    permissions: (id: string) => number,
    listen: (changed: () => void) => () => void,
  ): void {
    this.summaries.permissions(permissions);
    const changed = () => {
      this.summaries.refresh();
    };
    changed();
    this.#stops.push(listen(changed));
  }
  #operation?: {
    value: (target: OperationTarget) => "working" | "blocked" | undefined;
    targets: () => readonly OperationTarget[];
  };
  #operationInput(target: OperationTarget): void {
    const value = this.#operation?.value(target);
    if (target.kind === "session") this.states.operation(target.id, value);
    else {
      this.states.checkoutOperation(this.summaries.leaf(target.id), value);
    }
  }
  /** S22: received OTK operations, borrowed by target session or, without a
   * session, by project directory (P30 shows the ones not yet received). */
  operationAttention(
    value: (target: OperationTarget) => "working" | "blocked" | undefined,
    targets: () => readonly OperationTarget[],
    listen: (changed: (target: OperationTarget) => void) => () => void,
  ): void {
    this.#operation = { value, targets };
    const changed = (target: OperationTarget) => {
      this.#operationInput(target);
      if (target.kind === "session") {
        this.summaries.mark(target.id);
      } else this.summaries.touch(target.id);
    };
    this.#stops.push(listen(changed));
    for (const target of targets()) changed(target);
  }
  locationAttention(
    values: () => Readonly<Record<string, number>>,
    listen: (changed: () => void) => () => void,
  ): void {
    this.summaries.locationForms(values());
    this.#stops.push(listen(() => this.summaries.locationForms(values())));
  }
  #summaryDirectories(): void {
    this.summaries.retain([...this.#projects.keys(), ...this.#discovered]);
  }
  #identity(): void {
    const user = this.user;
    if (user === this.#user) return;
    this.stores.projects.materialize(user);
    this.#user = user;
    this.#projects = new Map(
      this.stores.projects.list(user).map((
        project,
      ) => [project.directory, project]),
    );
    this.projectOrder.admit(user, [
      ...this.#projects.keys(),
      ...this.#discovered,
      ...this.summaries?.values.keys() ?? [],
    ]);
    this.#generation = crypto.randomUUID();
    this.#revision = 0;
    this.#pending.clear();
    this.#summaryPending.clear();
    this.#summaryRevision = 0;
    // A new generation re-baselines every client: no transition spans users.
    this.states.reset();
    for (const target of this.#operation?.targets() ?? []) {
      this.#operationInput(target);
    }
    this.summaries?.refresh();
    this.#taskRoots();
  }
  get(view?: ViewLease, leased?: ReadonlySet<string>): InboxSnapshot {
    this.#identity();
    const directory = view && this.#directory(view);
    if (view && !leased) leased = new Set();
    const taskStates = new Set(
      view ? this.#listedTasks(view) : [...this.#taskScopes.values()].flatMap((
        read,
      ) => [...this.#listedTasks(read())]),
    );
    return {
      projects: [...this.#projects.values()].sort((a, b) =>
        a.order - b.order || a.directory.localeCompare(b.directory)
      ).map((p) => ({ ...p })),
      tasks: [
        ...(view
          ? directory
            ? this.#projectTasks(directory, view.tasksFollowParent)
            : []
          : this.#tasks.values()),
      ].sort((a, b) => a.order - b.order || a.id.localeCompare(b.id)).map((
        t,
      ) => ({ ...t, sessions: [...t.sessions] })),
      seen: Object.fromEntries(
        leased
          ? [...leased].flatMap((id) => {
            const time = this.#seen.get(this.user)?.get(id);
            return time === undefined ? [] : [[id, time]];
          })
          : this.#seen.get(this.user) ?? [],
      ),
      finishes: Object.fromEntries(
        leased
          ? [...leased].flatMap((id) => {
            const time = this.#finishes.get(id);
            return time === undefined ? [] : [[id, time]];
          })
          : this.#finishes,
      ),
      // Sessions follow the lease; aggregates are per-user scalars for all views.
      entities: Object.fromEntries(
        leased
          ? [
            ...[...this.states.values()].filter(([, value]) =>
              value.kind !== "session" &&
              (value.kind !== "task" || taskStates.has(value.id))
            ),
            ...[...leased].flatMap((id) => {
              const value = this.#sessionForView(id, view?.selected);
              return value ? [[entityKey("session", id), value] as const] : [];
            }),
          ]
          : [...this.states.values()].filter(([, value]) =>
            value.kind !== "task" || taskStates.has(value.id)
          ),
      ),
      pathTemplates: [...this.#templates],
      discovered: [...this.#discovered],
      summaries: Object.fromEntries(this.summaries.values),
      ...(this.#discoveryError ? { discoveryError: this.#discoveryError } : {}),
    };
  }
  async baseline(signal?: AbortSignal): Promise<InboxBaseline> {
    // Copy in bounded turns and replay only keys changed during that copy.
    // Ongoing mark traffic does not require a quiet serving isolate. Only a
    // generation replacement or bounded-capture overflow restarts assembly.
    for (;;) {
      signal?.throwIfAborted();
      if (this.#closed) throw new DOMException("Inbox closed", "AbortError");
      this.#identity();
      this.#flush();
      const generation = this.#generation;
      const assembly: InboxAssembly = { dirty: new Map(), overflow: false };
      this.#assemblies.add(assembly);
      const maps: InboxMaps = {
        entities: new Map(),

        summaries: new Map(),
        projects: new Map(),
        tasks: new Map(),
        seen: new Map(),
        finishes: new Map(),
      };
      try {
        let copied = 0;
        const copy = async <T>(
          source: Map<string, T>,
          target: Map<string, T>,
        ) => {
          for (const [id, value] of source) {
            if (assembly.overflow) return;
            target.set(id, structuredClone(value));
            if (this.snapshotRows && ++copied % this.snapshotRows === 0) {
              await new Promise((resolve) => setTimeout(resolve, 0));
              signal?.throwIfAborted();
              if (this.#closed) {
                throw new DOMException("Inbox closed", "AbortError");
              }
            }
          }
        };
        const source = this.#maps();
        await copy(source.projects, maps.projects);
        await copy(source.tasks, maps.tasks);
        await copy(source.seen, maps.seen);
        await copy(source.finishes, maps.finishes);

        await copy(source.entities, maps.entities);
        await copy(source.summaries, maps.summaries);
        this.#flush();
        if (assembly.overflow || generation !== this.#generation) continue;
        const current = this.#maps();
        for (const { kind, id } of assembly.dirty.values()) {
          const target = maps[kind] as Map<
            string,
            | ProjectRecord
            | TaskRecord
            | ProjectSummary
            | EntityState
            | number
          >;
          const value = current[kind].get(id);
          if (value === undefined) target.delete(id);
          else target.set(id, structuredClone(value));
        }
        const inbox: InboxSnapshot = {
          projects: [...maps.projects.values()].sort((a, b) =>
            a.order - b.order || a.directory.localeCompare(b.directory)
          ),
          tasks: [...maps.tasks.values()].sort((a, b) =>
            a.order - b.order || a.id.localeCompare(b.id)
          ),
          seen: Object.fromEntries(maps.seen),
          finishes: Object.fromEntries(maps.finishes),

          entities: Object.fromEntries(maps.entities),
          pathTemplates: [...this.#templates],
          discovered: [...this.#discovered],
          summaries: Object.fromEntries(maps.summaries),
          ...(this.#discoveryError
            ? { discoveryError: this.#discoveryError }
            : {}),
        };
        return {
          generation,
          revision: this.#revision,
          summaryRevision: this.#summaryRevision,
          inbox,
        };
      } finally {
        this.#assemblies.delete(assembly);
      }
    }
  }
  #maps(): InboxMaps {
    return {
      entities: this.states.values(),

      summaries: this.summaries.values,
      projects: this.#projects,
      tasks: this.#tasks,
      seen: this.#seen.get(this.#user) ?? new Map(),
      finishes: this.#finishes,
    };
  }
  #capture(kind: keyof InboxMaps, id: string): void {
    const key = JSON.stringify([kind, id]);
    for (const assembly of this.#assemblies) {
      if (assembly.overflow || assembly.dirty.has(key)) continue;
      const limit = this.snapshotPending ?? this.snapshotRows;
      if (limit !== undefined && assembly.dirty.size >= limit) {
        assembly.overflow = true;
        assembly.dirty.clear();
      } else assembly.dirty.set(key, { kind, id });
    }
  }
  async snapshot(
    signal?: AbortSignal,
  ): Promise<Extract<ServerFrame, { t: "inbox.snapshot" }>> {
    return { t: "inbox.snapshot", ...await this.baseline(signal) };
  }
  listen(listener: (frame: ServerFrame) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }
  close(): void {
    this.#closed = true;
    this.#dependencyAbort.abort();
    this.states.close();
    this.projectOrder.close();
    for (const stop of this.#stops.splice(0)) stop();
    this.#listeners.clear();
    this.#publications.clear();
  }
  #queue(
    key: string,
    op: InboxOp,
    scope: Omit<InboxPublication, "value"> = {},
  ): void {
    this.#pending.set(key, { value: op, ...scope });
    this.#schedule();
  }
  #schedule(): void {
    if (this.#scheduled || this.#closed) return;
    this.#scheduled = true;
    queueMicrotask(() => {
      this.#scheduled = false;
      if (this.#closed) return;
      this.#flush();
    });
  }
  #flush(): void {
    if (this.#summaryPending.size && !this.#closed) {
      const summaries: ProjectSummary[] = [], remove: string[] = [];
      for (const [directory, summary] of this.#summaryPending) {
        if (summary) summaries.push(summary);
        else remove.push(directory);
      }
      this.#summaryPending.clear();
      const from = this.#summaryRevision;
      this.#summaryRevision += summaries.length + remove.length;
      const frame: ServerFrame = {
        t: "inbox.summaries",
        generation: this.#generation,
        from,
        revision: this.#summaryRevision,
        summaries,
        ...(remove.length ? { remove } : {}),
      };
      for (const listener of this.#listeners) listener(structuredClone(frame));
    }
    if (!this.#pending.size || this.#closed) return;
    const changes = [...this.#pending.values()],
      ops = changes.map((change) => change.value);
    this.#pending.clear();
    const from = this.#revision;
    this.#revision += ops.length;
    const frame: ServerFrame = {
      t: "inbox.patch",
      generation: this.#generation,
      from,
      revision: this.#revision,
      ops,
    };
    for (const listener of this.#listeners) listener(structuredClone(frame));
    for (const listener of this.#publications) listener(changes);
  }
  #observe(
    entry: IndexMetadata,
    previous?: IndexMetadata,
    tx?: StoreWrite,
  ): void {
    const s = this.stores;
    const terminal = entry.activity?.terminal;
    if (
      !entry.deleted && terminal &&
      terminal > (this.#finishes.get(entry.id) ?? 0)
    ) s.finishes.observe(entry.id, terminal, tx);
    const supervision = this.states.session(
      entry,
      this.#seen.get(this.user)?.get(entry.id) ?? 0,
      this.#finishes.get(entry.id),
    );
    // Persist activity policy from supervision, not the temporary entity lamp
    // (which also includes received operations such as closing a terminal).
    const active = supervision.state === "working" ||
      supervision.state === "needsYou";
    const unseen = [...new Set([...this.#seen.keys(), this.user])].some((
      user,
    ) => this.#unseen(entry.id, user));
    if (
      !entry.deleted && (active || unseen) &&
      (!previous || previous.status !== entry.status ||
        JSON.stringify(previous.attention) !==
          JSON.stringify(entry.attention) ||
        JSON.stringify(previous.activity) !== JSON.stringify(entry.activity))
    ) {
      const promote = () => this.promote?.(entry.id);
      if (tx) s.projects.db.afterCommit(tx, promote);
      else promote();
    }
    // Joined writes have not published their policy changes yet. Revalidate
    // against that transaction's current rows, using the same activity owner.
    const leaf = this.summaries.leaf(entry.directory, entry.projectID);
    const context = this.summaries.context(leaf);
    for (const project of tx ? s.projects.policies() : this.#policies) {
      if (
        !entry.deleted &&
        (project.directory === leaf || project.directory === context ||
          project.directory === entry.directory) &&
        project.inactive &&
        (active || this.#unseen(entry.id, project.user))
      ) {
        s.projects.reactivate(project.user, project.directory, tx);
      }
    }
  }
  /** Creation and successful action bookkeeping share the persisted project owner. */
  activate(directory: string, tx?: StoreWrite): void {
    const project = this.stores.projects.find(this.user, directory);
    if (!project) this.stores.projects.add(this.user, directory, tx);
    else if (project.inactive) {
      this.stores.projects.inactive(this.user, directory, false, tx);
    }
  }
  async #scan(): Promise<void> {
    const version = ++this.#scanVersion;
    // Retired template results must not survive a new configuration.
    this.#discovered = [];
    this.#discoveryError = "";
    try {
      const paths = await this.scan(this.#templates);
      if (this.#closed || version !== this.#scanVersion) return;
      this.projectOrder.admit(this.user, paths);
      this.#discovered = paths;
      this.#summaryDirectories();
    } catch (error) {
      if (this.#closed || version !== this.#scanVersion) return;
      this.#discoveryError = errorMessage(error);
    }
    this.#queue("discovery", {
      op: "discovery",
      directories: [...this.#discovered],
      ...(this.#discoveryError
        ? {
          failure: {
            code: "discovery.unavailable",
            retry: "new-intent" as const,
            diagnosticID: crypto.randomUUID(),
          },
        }
        : {}),
    });
  }
  async #validateAcknowledgement(
    ctx: RpcContext,
    entries: readonly { session: string; terminal: number }[],
  ): Promise<void> {
    await ctx.sessionDirectories(
      entries.flatMap(({ session }) =>
        this.index.getMetadata(session)?.deleted ? [] : [session]
      ),
    );
    if (
      entries.some(({ session, terminal }) =>
        terminal > (this.#finishes.get(session) ?? 0)
      )
    ) throw new HarnessError("params", "Terminal token was not published");
  }

  #acknowledge(
    entries: readonly { session: string; terminal: number }[],
    tx: StoreWrite,
  ): number[] {
    return this.stores.seen.acknowledgeMany(this.user, entries, tx);
  }

  register(rpc: RpcRegistry): void {
    const s = this.stores, user = () => this.user;
    const added = (ctx: RpcContext, session: ContentSession) => {
      const run = (tx: StoreWrite) => {
        this.activate(session.directory, tx);
        return {
          ...s.projects.get(user(), session.directory),
          sessionID: session.id,
        };
      };
      return ctx.execution
        ? ctx.execution.local(run, projectSessionReceipt.encode)
        : ctx.store.write(run);
    };
    const strings = (p: Record<string, unknown>, name: string): string[] => {
      const values = p[name];
      if (
        !Array.isArray(values) ||
        values.some((v) => typeof v !== "string" || !v.length) ||
        new Set(values).size !== values.length
      ) throw new HarnessError("params", `Expected unique ${name} strings`);
      return values as string[];
    };
    const sessions = (p: Record<string, unknown>) => {
      const values = strings(p, "sessions");
      if (!values.every(isSessionID)) {
        throw new HarnessError("params", "Expected qualified session IDs");
      }
      return values;
    };
    rpc.register("inbox.get", {
      execution: readExecution(() => ({ resource: "inbox" })),
      params: () => undefined,
      handler: (ctx) =>
        this.#views.get(ctx.request?.id ?? "")?.() ??
          this.baseline(ctx.execution?.signal),
    });
    rpc.register("projects.list", {
      execution: readExecution(() => ({ resource: "projects" })),
      params: () => undefined,
      handler: () => s.projects.list(user()),
    });
    const savedOrder = () => ({ revision: this.projectOrder.revision });
    rpc.register("projects.move", {
      execution: localResultExecution(
        (p: ProjectMove) => ({ resource: `project-order:${p.id}` }),
        orderMoveReceipt,
        savedOrder,
      ),
      params(p): ProjectMove {
        const id = text(p, "id")!;
        const before = text(p, "before", true), after = text(p, "after", true);
        if (
          (before === undefined) === (after === undefined) || before === "" ||
          after === ""
        ) {
          throw new HarnessError(
            "params",
            "Expected exactly one project move target",
          );
        }
        return before !== undefined ? { id, before } : { id, after: after! };
      },
      handler: (ctx, p) => {
        localWrite(ctx, (tx) => {
          this.projectOrder.move(user(), p, tx);
          return true as const;
        }, orderMoveReceipt);
        return savedOrder();
      },
    });
    rpc.register("projects.add", {
      execution: {
        ...nativeExecution(
          (directory: string) => ({ directory }),
          projectSessionReceipt,
        ),
        checkpoint: (receipt) =>
          receipt.kind === createdReceipt.kind
            ? createdReceipt.validate(receipt)
            : projectSessionReceipt.validate(receipt),
        recover: (ctx, record, execution) => {
          if (record.receipt_kind === projectSessionReceipt.kind) {
            return Promise.resolve({
              state: "complete",
              result: projectSessionReceipt.restore(record),
            });
          }
          if (record.receipt_kind === createdReceipt.kind) {
            return Promise.resolve({
              state: "complete",
              result: added(
                { ...ctx, execution },
                createdReceipt.restore(record),
              ),
            });
          }
          return Promise.resolve({
            state: "pending",
            progress: { phase: "reconciling", code: "checking-outcome" },
          });
        },
      },
      params: (p) => projectPath(text(p, "directory")!),
      handler: async (ctx, directory) => {
        if (!(await Deno.stat(directory)).isDirectory) {
          throw new HarnessError("params", "Expected a project directory");
        }
        // The existing Add project entry creates its initial session; empty
        // directory-only tracking is no longer a product operation.
        const session = await nativeEffect(
          ctx,
          (operation) =>
            ctx.harness.core.createSession({ directory }, operation),
          createdReceipt,
        );
        return added(ctx, session);
      },
    });
    rpc.register("projects.inactive", {
      execution: localExecution(
        (p: { directory: string }) => ({ directory: p.directory }),
        projectReceipt,
      ),
      params(p) {
        if (typeof p.inactive !== "boolean") {
          throw new HarnessError("params", "Expected inactive boolean");
        }
        return {
          directory: projectPath(text(p, "directory")!),
          inactive: p.inactive,
        };
      },
      handler: (ctx, p) =>
        localWrite(ctx, (tx) => {
          if (!s.projects.find(user(), p.directory)) {
            s.projects.discover(p.directory, tx);
            s.projects.materialize(user(), tx);
          }
          s.projects.inactive(user(), p.directory, p.inactive, tx);
          for (const entry of this.index.values()) {
            const leaf = this.summaries.leaf(entry.directory, entry.projectID);
            if (
              entry.directory === p.directory || leaf === p.directory ||
              this.summaries.context(leaf) === p.directory
            ) {
              this.#observe(entry, undefined, tx);
            }
          }
          return s.projects.get(user(), p.directory);
        }, projectReceipt),
    });
    rpc.register("projects.visit", {
      execution: localExecution(
        (p: { directory: string }) => ({ directory: p.directory }),
        visitReceipt,
      ),
      params(p) {
        if (p.active !== undefined && typeof p.active !== "boolean") {
          throw new HarnessError("params", "Expected active boolean");
        }
        return {
          directory: projectPath(text(p, "directory")!),
          active: p.active === true,
        };
      },
      handler: (ctx, p) =>
        localWrite(ctx, (tx) => {
          if (p.active) this.activate(p.directory, tx);
          return s.projects.find(user(), p.directory)
            ? s.projects.visit(user(), p.directory, tx)
            : null;
        }, visitReceipt),
    });
    rpc.register("projects.scan", {
      execution: readExecution(() => ({ resource: "project-discovery" })),
      params: () => undefined,
      handler: (ctx) => scanProjects(s.templates.list(), ctx.execution?.signal),
    });
    rpc.register("projects.templates", {
      execution: localExecution(
        () => ({ resource: "project-templates" }),
        templatesReceipt,
      ),
      params: (p) => strings(p, "templates").map(pathTemplate),
      handler: (ctx, templates) =>
        localWrite(
          ctx,
          (tx) => s.templates.set(templates, tx),
          templatesReceipt,
        ),
    });
    rpc.register("tasks.list", {
      execution: readExecution((directory: string | undefined) => ({
        directory,
      })),
      params: (p) =>
        p.directory === undefined
          ? undefined
          : projectPath(text(p, "directory")!),
      handler: (ctx, directory) => {
        const selected = ctx.request?.view?.();
        const project = directory ?? (selected && this.#directory(selected));
        return ctx.request && !project ? [] : s.tasks.list(project);
      },
    });
    rpc.register("tasks.create", {
      execution: preparedLocalExecution(
        (p: { directory: string }) => ({ directory: p.directory }),
        taskReceipt,
      ),
      params: (p) => ({
        directory: projectPath(text(p, "directory")!),
        name: text(p, "name")!,
        sessions: p.sessions === undefined ? [] : sessions(p),
      }),
      async handler(ctx, p) {
        const directories = await ctx.sessionDirectories(p.sessions);
        for (const id of p.sessions) {
          if (directories[id] !== p.directory) {
            throw new HarnessError(
              "params",
              "Session belongs to another project",
            );
          }
        }
        return localWrite(
          ctx,
          (tx) => s.tasks.create(p.directory, p.name, p.sessions, tx),
          taskReceipt,
        );
      },
    });
    rpc.register("tasks.rename", {
      execution: localExecution(
        (p: { id: string }) => ({ resource: p.id }),
        taskReceipt,
      ),
      params: (p) => ({ id: text(p, "id")!, name: text(p, "name")! }),
      handler: (ctx, p) =>
        localWrite(ctx, (tx) => s.tasks.rename(p.id, p.name, tx), taskReceipt),
    });
    rpc.register("tasks.reorder", {
      execution: localExecution(
        (p: { directory: string }) => ({ directory: p.directory }),
        tasksReceipt,
      ),
      params: (p) => ({
        directory: projectPath(text(p, "directory")!),
        ids: strings(p, "ids"),
      }),
      handler: (ctx, p) =>
        localWrite(
          ctx,
          (tx) => s.tasks.reorder(p.directory, p.ids, tx),
          tasksReceipt,
        ),
    });
    rpc.register("tasks.close", {
      execution: localResultExecution(
        (id: string) => ({ resource: id }),
        closedReceipt,
        () => null,
      ),
      params: (p) => text(p, "id")!,
      handler: (ctx, id) => {
        localWrite(ctx, (tx) => {
          s.tasks.close(id, tx);
          return { taskID: id, closed: true as const };
        }, closedReceipt);
        return null;
      },
    });
    const member = (p: Record<string, unknown>) => ({
      id: text(p, "id")!,
      sessionID: sessionID(p)!,
    });
    rpc.register("tasks.addSession", {
      execution: {
        ...preparedLocalExecution(
          (p: { sessionID: string; id: string }) => ({
            sessionID: p.sessionID,
            resource: p.id,
          }),
          taskReceipt,
        ),
        ordering: "target",
      },
      params: member,
      async handler(ctx, p) {
        const directory = s.tasks.get(p.id).directory;
        if (await ctx.sessionDirectory(p.sessionID) !== directory) {
          throw new HarnessError(
            "params",
            "Session belongs to another project",
          );
        }
        return localWrite(ctx, (tx) => {
          if (s.tasks.get(p.id).directory !== directory) {
            throw new HarnessError("params", "Task project changed");
          }
          return s.tasks.addSession(p.id, p.sessionID, tx);
        }, taskReceipt);
      },
    });
    rpc.register("tasks.removeSession", {
      execution: {
        ...localExecution(
          (p: { sessionID: string; id: string }) => ({
            sessionID: p.sessionID,
            resource: p.id,
          }),
          taskReceipt,
        ),
        ordering: "target",
      },
      params: member,
      handler: (ctx, p) =>
        localWrite(
          ctx,
          (tx) => s.tasks.removeSession(p.id, p.sessionID, tx),
          taskReceipt,
        ),
    });
    rpc.register("tasks.sessions", {
      execution: {
        ...preparedLocalExecution(
          (p: { id: string }) => ({ resource: p.id }),
          taskReceipt,
        ),
        ordering: "target",
      },
      params: (p) => ({ id: text(p, "id")!, sessions: sessions(p) }),
      async handler(ctx, p) {
        const directory = s.tasks.get(p.id).directory;
        const directories = await ctx.sessionDirectories(p.sessions);
        for (const id of p.sessions) {
          if (directories[id] !== directory) {
            throw new HarnessError(
              "params",
              "Session belongs to another project",
            );
          }
        }
        return localWrite(ctx, (tx) => {
          if (s.tasks.get(p.id).directory !== directory) {
            throw new HarnessError("params", "Task project changed");
          }
          return s.tasks.sessions(p.id, p.sessions, tx);
        }, taskReceipt);
      },
    });
    rpc.register("sessions.seen", {
      execution: preparedLocalExecution(
        (p: { sessionID: string; terminal: number }) => ({
          sessionID: p.sessionID,
        }),
        seenReceipt,
      ),
      params: (p) => {
        if (!Number.isSafeInteger(p.terminal) || Number(p.terminal) < 0) {
          throw new HarnessError("params", "Expected terminal token");
        }
        return { sessionID: sessionID(p)!, terminal: Number(p.terminal) };
      },
      handler: async (ctx, { sessionID: id, terminal }) => {
        const entries = [{ session: id, terminal }];
        await this.#validateAcknowledgement(ctx, entries);
        return localWrite(
          ctx,
          (tx) => this.#acknowledge(entries, tx)[0],
          seenReceipt,
        );
      },
    });
    rpc.register("sessions.acknowledge", {
      execution: preparedLocalExecution(
        (p: AcknowledgeScope) =>
          p.scope === "helpers"
            ? { resource: p.task }
            : { sessionID: p.sessionID },
        acknowledgeReceipt,
      ),
      params: (p): AcknowledgeScope => {
        if (p.scope === "helpers") {
          return { scope: "helpers", task: text(p, "task")! };
        }
        if (p.scope === "subtree") {
          return { scope: "subtree", sessionID: sessionID(p)! };
        }
        throw new HarnessError("params", "Expected helpers or subtree scope");
      },
      handler: async (ctx, p) => {
        if (p.scope === "subtree") await ctx.sessionDirectory(p.sessionID);
        const ids = p.scope === "helpers"
          ? this.states.finishedHelpers(p.task)
          : this.states.subtree(p.sessionID);
        if (!ids) throw new HarnessError("params", "Task not found");
        const sessions = ids.flatMap((sessionID) => {
          const value = this.states.get(entityKey("session", sessionID));
          return value?.counts.unseen && value.terminal
            ? [{ sessionID, terminal: value.terminal }]
            : [];
        });
        const entries = sessions.map(({ sessionID, terminal }) => ({
          session: sessionID,
          terminal,
        }));
        await this.#validateAcknowledgement(ctx, entries);
        return localWrite(ctx, (tx) => {
          this.#acknowledge(entries, tx);
          return { sessions };
        }, acknowledgeReceipt);
      },
    });
    rpc.register("sessions.finishes", {
      execution: readExecution(() => ({ resource: "session-finishes" })),
      params: () => undefined,
      handler: (ctx) => {
        const ids = ctx.request?.entries?.();
        return ids
          ? Object.fromEntries(
            [...this.#finishes].filter(([id]) => ids.has(id)),
          )
          : s.finishes.tokens();
      },
    });
  }
}
