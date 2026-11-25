// SPDX-License-Identifier: LGPL-3.0-only
import { projectTree } from "./project-tree.ts";
import {
  createEntityStateStore,
  type EntityStateStore,
} from "./entity-state.ts";
import { entityKey, rollupStatus } from "@otk/protocol";
export { ROLLUP_PRIORITY, rollupStatus } from "@otk/protocol";
import type {
  InboxBaseline,
  InboxOp,
  InboxSnapshot,
  IndexMetadata,
  ProjectRecord,
  ProjectStatus,
  ProjectSummary,
  ProjectTopology,
  RpcMethod,
  RpcParams,
  RpcResult,
  ServerFrame,
  TaskRecord,
} from "@otk/protocol";
import { createState, type StateFactory } from "./state.ts";
import type { TabSession } from "./tabs.ts";
import { reportDiagnostic } from "./diagnostics.ts";
import { projectName } from "./project-navigation.ts";
import { age, type TimeText } from "./format.ts";
import {
  type ProjectPlacement,
  projectPlacement,
} from "./project-placement.ts";
import type { IntentGroups, RequestOptions } from "./requests.ts";
export type InboxStatus = ProjectStatus;
export interface OperationAttention {
  operationStatus?: InboxStatus;
}
/** Retained finish marks are unread only while their session is live. */
export function unread(
  session: Pick<IndexMetadata, "id" | "deleted">,
  inbox: Pick<InboxSnapshot, "seen" | "finishes" | "supervision">,
): boolean {
  if (session.deleted) return false;
  return inbox.supervision?.[session.id]?.unseen === true;
}
export function inboxStatus(
  entry: IndexMetadata & OperationAttention,
  inbox: Pick<InboxSnapshot, "seen" | "finishes" | "supervision">,
): InboxStatus {
  return rollupStatus(...sessionAttentionStates(entry, inbox));
}
/** Unranked evidence and operation facts; display and urgency choose separately. */
export function sessionAttentionStates(
  entry: IndexMetadata & OperationAttention,
  inbox: Pick<InboxSnapshot, "seen" | "finishes" | "supervision">,
): readonly (InboxStatus | undefined)[] {
  // Tombstones retain historical metadata, never authority for live attention.
  if (entry.deleted) return ["none"];
  return [
    entry.operationStatus,
    supervisionStatus(entry.id, inbox),
  ];
}
/** Live supervision does not require a concurrently leased index entry. */
export function supervisionStatus(
  id: string,
  inbox: Pick<InboxSnapshot, "supervision">,
): InboxStatus {
  const state = inbox.supervision?.[id]?.state;
  return state === "needsYou"
    ? "blocked"
    : state === "finishedUnseen"
    ? "finished"
    : state ?? "none";
}
export function rollup(
  entries: readonly (IndexMetadata & OperationAttention)[],
  inbox: Pick<InboxSnapshot, "seen" | "finishes" | "supervision">,
): InboxStatus {
  const states = entries.map((entry) => inboxStatus(entry, inbox));
  return rollupStatus(...states);
}
/** The disclosure remains the attention surface even when its rows are folded. */
export function archiveAttention(
  rows: readonly { status: ProjectStatus; unseenCount?: number | null }[],
): { status: ProjectStatus; count: number; unseenCount: number | null } {
  return {
    status: rollupStatus(...rows.map((row) => row.status)),
    count: rows.length,
    unseenCount: rows.some((row) => row.unseenCount == null)
      ? null
      : rows.reduce((sum, row) => sum + row.unseenCount!, 0),
  };
}
export interface InboxProject extends ProjectRecord, Partial<ProjectPlacement> {
  topology?: ProjectTopology;
  availability?: ProjectSummary["availability"];
  archived?: boolean;
  depth?: number;
  level?: "project" | "worktree";
  artwork?: "avatar" | "none";
  displayName?: string;
  parentLabel?: string;
  /** A repo can be shown as context while its own independent policy is Inactive. */
  inactivePolicy?: boolean;
  group?: "active" | "discovered" | "inactive" | "archived";
  /** Older injected projections without a source are tracked projects. */
  source?: "tracked" | "index" | "template";
  status: InboxStatus;
  unread: boolean;
  unseenCount?: number | null;
  visit?: TimeText;
  visitText?: string;
  /** Unused: names are not tinted by visit age (S4). Optional only so
   * standalone fixtures that still name it keep type-checking. */
  ageing?: number;
}
/** Consume the owner's exact scope projection; never infer membership from paths. */
export function projectDirectory(
  directory: string,
  summaries: Readonly<Record<string, ProjectSummary>>,
  repoID?: string,
): string {
  const leaves = new Set<string>();
  for (const summary of Object.values(summaries)) {
    const memberships = summary.memberships?.filter((m) =>
      m.directory === directory && (repoID === undefined || m.repoID === repoID)
    );
    if (memberships?.length) {
      for (const membership of memberships) {
        leaves.add(membership.leafDirectory);
      }
      continue;
    }
    const topology = summary.topology;
    if (!topology || repoID !== undefined && topology.repoID !== repoID) {
      continue;
    }
    if (summary.scopes?.includes(directory)) leaves.add(topology.leafDirectory);
  }
  return leaves.size === 1 ? [...leaves][0] : directory;
}
type HierarchyRow<T> = T & {
  level: "project" | "worktree";
  artwork: "avatar" | "none";
  displayName: string;
};
// Projection rows are immutable owner snapshots. Presentation must retain their
// identity on digest-only publications, without retaining retired source rows.
const hierarchyRows = new WeakMap<
  InboxProject,
  { key: string; row: InboxProject }
>();
/** Hierarchy is presentation only: directory/task identities are never rewritten. */
export function projectHierarchy<
  T extends InboxProject & {
    sidecarId?: string;
    summary?: Pick<ProjectSummary, "presentation">;
  },
>(
  rows: readonly T[],
): HierarchyRow<T>[] {
  const result: HierarchyRow<T>[] = [];
  const walk = (
    node: ReturnType<typeof projectTree<T>>[number],
    depth = 0,
    parent?: T,
  ) => {
    const row = node.project;
    const worktree = !!row.topology &&
      row.topology.canonicalRoot !== row.directory;
    const presentation = {
      level: worktree ? "worktree" as const : "project" as const,
      artwork: worktree ? "none" as const : "avatar" as const,
      displayName: (!worktree && row.summary?.presentation?.name) ||
        projectName(row.directory),
    };
    const lifted = row.inactive &&
      node.children.some((child) =>
        ["active", "archived"].includes(projectGroup(child.project))
      );
    const parentLabel = parent
      ? projectName(parent.directory)
      : row.parentLabel;
    const key = JSON.stringify([
      presentation,
      lifted,
      parent ? depth : row.depth,
      parentLabel,
    ]);
    let cached = hierarchyRows.get(row);
    if (!cached || cached.key !== key) {
      const value = {
        ...(lifted
          ? {
            ...row,
            group: "active" as const,
            section: "live" as const,
            inactive: false,
            inactivePolicy: true,
          }
          : parent &&
              (row.depth !== depth ||
                row.parentLabel !== projectName(parent.directory))
          ? { ...row, depth, parentLabel: projectName(parent.directory) }
          : row),
        ...presentation,
      };
      cached = { key, row: value };
      hierarchyRows.set(row, cached);
    }
    result.push(cached.row as HierarchyRow<T>);
    for (const child of node.children) walk(child, depth + 1, row);
  };
  for (const root of projectTree(rows)) walk(root);
  return result;
}
/** Source provenance never decides presentation groups. */
export function projectGroup(
  project: Pick<InboxProject, "group" | "source" | "inactive" | "section">,
): "active" | "discovered" | "inactive" | "archived" {
  return (project.section === "live" ? "active" : project.section) ??
    project.group ??
    (project.inactive
      ? "inactive"
      : project.source === "template"
      ? "discovered"
      : "active");
}
/** One projection shared by the column, collapsed rail and tab badges. */
export function inboxProjects(
  entries: readonly (IndexMetadata & OperationAttention)[],
  inbox: InboxSnapshot,
  now: number,
): InboxProject[] {
  const resolve = (directory: string, repoID?: string) =>
    projectDirectory(directory, inbox.summaries ?? {}, repoID);
  entries = entries.map((entry) => ({
    ...entry,
    directory: resolve(entry.directory, entry.projectID),
  }));
  const records = new Map<string, ProjectRecord>();
  for (const record of inbox.projects) {
    const directory = resolve(record.directory);
    if (!records.has(directory) || directory === record.directory) {
      records.set(directory, { ...record, directory });
    }
  }
  const hasSessions = (directory: string, sessions: readonly IndexMetadata[]) =>
    inbox.summaries?.[directory]?.hasSessions ??
      ((inbox.summaries?.[directory]?.sessionCount ?? 0) > 0 ||
        sessions.some((entry) => !entry.deleted));
  const statusFor = (
    directory: string,
    sessions: readonly (IndexMetadata & OperationAttention)[],
  ) => {
    const summary = inbox.summaries?.[directory];
    return summary
      ? rollupStatus(
        summary.status ?? "none",
        ...sessions.map((entry) => entry.operationStatus),
      )
      : rollup(sessions, inbox);
  };
  const tracked = [...records.values()].filter((project) =>
    project.inactive || inbox.discovered?.includes(project.directory) ||
    hasSessions(
      project.directory,
      entries.filter((entry) => entry.directory === project.directory),
    )
  ).sort((a, b) => a.order - b.order).map(
    (project) => {
      const sessions = entries.filter((entry) =>
        entry.directory === project.directory
      );
      const status = statusFor(project.directory, sessions);
      const inactive = project.inactive && status === "none";
      const clock = inactive ? project.inactiveAt ?? project.lastVisit : now;
      return {
        ...project,
        source: "tracked" as const,
        group: inactive
          ? "inactive" as const
          : hasSessions(project.directory, sessions)
          ? "active" as const
          : "discovered" as const,
        inactive,
        status,
        unread: (inbox.summaries?.[project.directory]?.unseenCount ?? 0) > 0 ||
          sessions.some((s) => unread(s, inbox)),
        visit: age(project.lastVisit, clock, inactive ? "inactive" : "now"),
      };
    },
  );
  const known = new Set(tracked.map((p) => p.directory));
  const indexed = new Map<string, IndexMetadata[]>();
  for (const entry of entries) {
    if (known.has(entry.directory)) continue;
    const sessions = indexed.get(entry.directory) ?? [];
    sessions.push(entry);
    indexed.set(entry.directory, sessions);
  }
  for (const summary of Object.values(inbox.summaries ?? {})) {
    if (
      !known.has(summary.directory) && summary.hasSessions &&
      !indexed.has(summary.directory) &&
      resolve(summary.directory) === summary.directory
    ) {
      indexed.set(summary.directory, []);
    }
  }
  const discovered = [...indexed].map(([directory, sessions]): InboxProject => {
    known.add(directory);
    return {
      directory,
      source: "index",
      group: "active",
      order: 0,
      added: false,
      inactive: false,
      lastVisit: 0,
      status: statusFor(directory, sessions),
      unread: (inbox.summaries?.[directory]?.unseenCount ?? 0) > 0 ||
        sessions.some((s) => unread(s, inbox)),
    };
  });
  const templates = [
    ...new Set((inbox.discovered ?? []).map((d) => resolve(d))),
  ].filter((p) => !known.has(p))
    .map((directory): InboxProject => ({
      directory,
      source: "template",
      group: "discovered",
      order: 0,
      added: false,
      inactive: false,
      lastVisit: 0,
      status: "none",
      unread: false,
    }));
  return projectHierarchy(
    [...tracked, ...discovered, ...templates].map((row) => {
      const summary = inbox.summaries?.[row.directory];
      const archived = summary?.archived === true;
      const placement = projectPlacement({
        lifecycle: summary,
        status: row.status,
        inactive: row.inactive,
        hasSessions: row.group !== "discovered",
      });
      return {
        ...row,
        ...placement,
        group: placement.section === "live"
          ? "active" as const
          : placement.section,
        unseenCount: summary
          ? summary.unseenCount
          : entries.filter((entry) =>
            entry.directory === row.directory && unread(entry, inbox)
          ).length,
        archived,
        topology: summary?.topology,
        availability: summary?.availability,
      };
    }),
  );
}
export interface InboxRpc {
  call<M extends RpcMethod>(
    method: M,
    params: RpcParams<M>,
    signal?: AbortSignal | RequestOptions,
  ): Promise<RpcResult<M>>;
  readonly intents?: IntentGroups;
}
export interface InboxState {
  /** The initial snapshot is unknown until its first accepted metadata frame. */
  ready: boolean;
  inbox: InboxSnapshot;
}
export interface InboxChanges {
  baseline: boolean;
  /** Changed single-state keys; no client re-aggregation. */
  entities?: readonly string[];
  /** Known facts for sessions newly in the view, not new events. */
  admitted?: boolean;
  projects: readonly string[];
  sessions: readonly string[];
  tasks: boolean;
  discovery: boolean;
}
export interface InboxModel {
  stop(): void;
  state: InboxState;
  /** Presentation view of the entity replica: receipt times and transitions. */
  readonly entities: EntityStateStore;
  subscribe(listener: (state: InboxState) => void): () => void;
  observeChanges(listener: (changes: InboxChanges) => void): () => void;
  receive(frame: ServerFrame): void;
  promote(session: TabSession, options?: RequestOptions): Promise<TaskRecord>;
  openProject(directory: string): Promise<void>;
  openSession(
    sessionID: string,
    directory: string,
    terminal?: number,
  ): Promise<void>;
  act<T>(
    directory: string,
    action: () => Promise<T>,
    options?: RequestOptions,
  ): Promise<T>;
}
/** Connection-local model; the caller owns routing, clock scheduling and errors. */
export function createInbox(
  rpc: InboxRpc,
  factory: StateFactory = createState,
  report: (error: unknown) => void = (error) =>
    console.error("Visit bookkeeping failed after successful action", error),
  currentEpoch?: () => number,
  /** Client arrival of a request identity (the request-lifetime owner). */
  arrival?: (id: string) => number | undefined,
  /** The connection's reactive state, for stale entity presentation (D6). */
  connected?: () => boolean,
): InboxModel {
  // Accepted metadata is invocation-current, like ClientIndex. Framework state
  // publishes a dependency clock; deferred binding cannot govern reduced facts.
  const current: InboxState = {
    ready: false,
    inbox: {
      projects: [],
      tasks: [],
      seen: {},
      finishes: {},
      pathTemplates: [],
    },
  };
  const clock = factory({ revision: 0 });
  const entityStates = createEntityStateStore({
    read: () => current.inbox.entities,
    factory,
    arrival,
    connected,
  });
  const state: InboxState = {
    get ready() {
      void clock.state.revision;
      return current.ready;
    },
    get inbox() {
      void clock.state.revision;
      return current.inbox;
    },
  };
  let generation: string | undefined, revision = -1, epoch = 0, alive = true;
  let summaryRevision = 0;
  let observedSummary: { generation: string; revision: number } | undefined;
  let recoveryController: AbortController | undefined;
  let recovering: Promise<void> | undefined;
  let observed: { generation: string; revision: number } | undefined;
  const listeners = new Set<(changes: InboxChanges) => void>();
  const publish = (changes: InboxChanges) => {
    for (const listener of listeners) listener(changes);
  };
  const baseline = (value: InboxBaseline) => {
    if ((value.epoch ?? 0) < (currentEpoch?.() ?? 0)) return;
    if (generation !== undefined && value.generation !== generation) return;
    if (
      value.generation === generation && (value.revision < revision ||
        (value.summaryRevision ?? 0) < summaryRevision)
    ) return;
    generation = value.generation;
    revision = value.revision;
    summaryRevision = value.summaryRevision ?? 0;
    current.inbox = {
      ...value.inbox,
      projects: [...value.inbox.projects],
      tasks: [...value.inbox.tasks],
      seen: { ...value.inbox.seen },
      finishes: { ...value.inbox.finishes },
      ...(value.inbox.supervision
        ? { supervision: { ...value.inbox.supervision } }
        : {}),
      ...(value.inbox.entities
        ? { entities: { ...value.inbox.entities } }
        : {}),
    };
    current.ready = true;
    clock.update((draft) => {
      draft.revision++;
    });
    entityStates.observe("all", "historical");
    publish({
      baseline: true,
      projects: [],
      sessions: [],
      tasks: true,
      discovery: true,
    });
  };
  const recover = () => {
    if (recovering) return;
    const at = epoch;
    const controller = new AbortController();
    recoveryController = controller;
    const work = (async () => {
      for (;;) {
        const value = await rpc.call("inbox.get", {}, controller.signal);
        if (!alive || at !== epoch || controller.signal.aborted) return;
        if (
          observed && !observedSummary && generation === observed.generation &&
          revision >= observed.revision
        ) {
          observed = undefined;
          return;
        }
        // An asynchronous baseline cannot cover a later observed patch. Reacquire
        // instead of retaining an unbounded replay log or dropping a mark.
        if (
          observed?.generation === value.generation &&
          observed.revision > value.revision
        ) continue;
        if (
          observedSummary?.generation === value.generation &&
          observedSummary.revision > (value.summaryRevision ?? 0)
        ) continue;
        if (
          value.generation === generation &&
          (value.summaryRevision ?? 0) < summaryRevision
        ) continue;
        if (generation !== value.generation) generation = undefined;
        baseline(value);
        observed = undefined;
        observedSummary = undefined;
        return;
      }
    })().catch((error) => {
      if (alive && at === epoch && !controller.signal.aborted) {
        reportDiagnostic(report, error);
      }
    }).finally(() => {
      if (recovering === work) recovering = undefined;
    });
    recovering = work;
  };
  const apply = (draft: InboxSnapshot, op: InboxOp) => {
    switch (op.op) {
      case "entity.upsert":
        (draft.entities ??= {})[entityKey(op.value.kind, op.value.id)] =
          op.value;
        break;
      case "entity.remove":
        if (draft.entities) delete draft.entities[op.key];
        break;
      case "project.upsert": {
        const at = draft.projects.findIndex((p) =>
          p.directory === op.project.directory
        );
        if (at < 0) draft.projects.push(op.project);
        else draft.projects[at] = op.project;
        draft.projects.sort((a, b) =>
          a.order - b.order || a.directory.localeCompare(b.directory)
        );
        break;
      }
      case "project.remove":
        draft.projects = draft.projects.filter((p) =>
          p.directory !== op.directory
        );
        break;
      case "task.upsert": {
        const at = draft.tasks.findIndex((t) => t.id === op.task.id);
        if (at < 0) draft.tasks.push(op.task);
        else draft.tasks[at] = op.task;
        draft.tasks.sort((a, b) =>
          a.order - b.order || a.id.localeCompare(b.id)
        );
        break;
      }
      case "task.remove":
        draft.tasks = draft.tasks.filter((t) => t.id !== op.id);
        break;
      case "seen":
        draft.seen[op.sessionID] = op.time;
        break;
      case "finish":
        draft.finishes[op.sessionID] = op.time;
        break;
      case "supervision":
        draft.supervision ??= {};
        if (op.value) draft.supervision[op.sessionID] = op.value;
        else delete draft.supervision[op.sessionID];
        break;
      case "templates":
        draft.pathTemplates = op.values;
        break;
      case "discovery":
        draft.discovered = op.directories;
        draft.discoveryFailure = op.failure;
        break;
    }
  };
  return {
    stop() {
      alive = false;
      listeners.clear();
      epoch++;
      recoveryController?.abort();
      recoveryController = undefined;
      recovering = undefined;
      entityStates.stop();
    },
    state,
    entities: entityStates,
    subscribe: (listener) => clock.subscribe(() => listener(state)),
    observeChanges(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    /** Atomic server-side promotion, suitable as createTabs' injected port. */
    promote(session: TabSession, options?: RequestOptions) {
      return rpc.call("tasks.create", {
        directory: session.directory,
        name: session.title || "Session",
        sessions: [session.id],
      }, options);
    },
    receive(frame: ServerFrame): void {
      if (!alive) return;
      if (frame.t === "welcome") {
        epoch++;
        recoveryController?.abort();
        recoveryController = undefined;
        generation = undefined;
        revision = -1;
        summaryRevision = 0;
        recovering = undefined;
        observed = undefined;
        observedSummary = undefined;
      } else if (frame.t === "inbox.snapshot") {
        baseline(frame);
        if (
          observed && observed.generation === generation &&
          revision >= observed.revision
        ) {
          observed = undefined;
          recoveryController?.abort();
        }
      } else if (frame.t === "inbox.summaries") {
        if (
          frame.generation === generation && frame.revision <= summaryRevision
        ) return;
        if (
          frame.generation !== generation || frame.from !== summaryRevision ||
          frame.revision !==
            frame.from + frame.summaries.length + (frame.remove?.length ?? 0)
        ) {
          observedSummary = {
            generation: frame.generation,
            revision: frame.revision,
          };
          recover();
          return;
        }
        summaryRevision = frame.revision;
        for (const summary of frame.summaries) {
          (current.inbox.summaries ??= {})[summary.directory] = summary;
        }
        for (const directory of frame.remove ?? []) {
          delete current.inbox.summaries?.[directory];
        }
        clock.update((draft) => {
          draft.revision++;
        });
        publish({
          baseline: false,
          projects: [
            ...frame.summaries.map((s) => s.directory),
            ...frame.remove ?? [],
          ],
          sessions: [],
          tasks: false,
          discovery: false,
        });
      } else if (frame.t === "inbox.patch") {
        if (frame.generation === generation && frame.revision <= revision) {
          return;
        }
        if (
          frame.generation !== generation || frame.from !== revision ||
          frame.revision !== frame.from + frame.ops.length
        ) {
          observed = { generation: frame.generation, revision: frame.revision };
          recover();
          return;
        }
        revision = frame.revision;
        for (const op of frame.ops) apply(current.inbox, op);
        clock.update((draft) => {
          draft.revision++;
        });
        const projects = new Set<string>(),
          sessions = new Set<string>(),
          entities = new Set<string>();
        let tasks = false, discovery = false;
        for (const op of frame.ops) {
          switch (op.op) {
            case "entity.upsert":
              entities.add(entityKey(op.value.kind, op.value.id));
              break;
            case "entity.remove":
              entities.add(op.key);
              break;
            case "project.upsert":
              projects.add(op.project.directory);
              break;
            case "project.remove":
              projects.add(op.directory);
              break;
            case "seen":
            case "finish":
            case "supervision":
              sessions.add(op.sessionID);
              break;
            case "task.upsert":
            case "task.remove":
              tasks = true;
              break;
            case "discovery":
              discovery = true;
              break;
            case "templates":
              break;
            default: {
              const unhandled: never = op;
              throw new Error(
                `Unhandled inbox operation: ${JSON.stringify(unhandled)}`,
              );
            }
          }
        }
        if (entities.size) {
          // Newly admitted facts are known state, never a live transition.
          entityStates.observe(
            [...entities],
            frame.admitted ? "historical" : "live",
          );
        }
        publish({
          baseline: false,
          ...(entities.size ? { entities: [...entities] } : {}),
          ...(frame.admitted ? { admitted: true } : {}),
          projects: [...projects],
          sessions: [...sessions],
          tasks,
          discovery,
        });
      }
    },
    async openProject(directory: string): Promise<void> {
      await rpc.call("projects.visit", { directory });
    },
    async openSession(
      sessionID: string,
      directory: string,
      terminal = current.inbox.supervision?.[sessionID]?.terminal ?? 0,
    ): Promise<void> {
      await rpc.call("projects.visit", { directory });
      await rpc.call("sessions.seen", { sessionID, terminal });
    },
    /** Wrap send/approve/answer/interrupt so every successful action resets visits. */
    async act<T>(
      directory: string,
      action: () => Promise<T>,
      options?: RequestOptions,
    ): Promise<T> {
      const result = await action();
      // The successful action is settled independently of its bookkeeping read/write.
      // A lost visit receipt must not keep an already-sent draft looking unsent.
      void rpc.call("projects.visit", { directory, active: true }, options)
        .catch((error) => reportDiagnostic(report, error));
      return result;
    },
  };
}
