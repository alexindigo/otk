// SPDX-License-Identifier: LGPL-3.0-only
import { DEFAULT_PROJECT_AGEING } from "@otk/protocol";
import type {
  InboxBaseline,
  InboxOp,
  InboxSnapshot,
  IndexMetadata,
  ProjectRecord,
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
import { relativeTime } from "./format.ts";
import type { IntentGroups, RequestOptions } from "./requests.ts";
/** Attention first. All aggregate lights use this one immutable priority order. */
export const INBOX_STATUS_PRIORITY = Object.freeze(
  [
    "blocked",
    "finished",
    "working",
    "idle",
  ] as const,
);
export type InboxStatus = typeof INBOX_STATUS_PRIORITY[number];
export interface OperationAttention {
  operationStatus?: InboxStatus;
}
export function attentionStatus(
  ...states: (InboxStatus | undefined)[]
): InboxStatus {
  return INBOX_STATUS_PRIORITY.find((state) => states.includes(state)) ??
    "idle";
}
export function unread(
  sessionID: string,
  inbox: Pick<InboxSnapshot, "seen" | "finishes">,
): boolean {
  return (inbox.finishes[sessionID] ?? 0) > (inbox.seen[sessionID] ?? 0);
}
export function inboxStatus(
  entry: IndexMetadata & OperationAttention,
  inbox: Pick<InboxSnapshot, "seen" | "finishes">,
): InboxStatus {
  const a = entry.attention;
  if (
    a.error ||
    a.permissions + a.questions + a.childPermissions + a.childQuestions > 0
  ) return "blocked";
  return attentionStatus(
    entry.operationStatus,
    entry.status !== "idle"
      ? "working"
      : !entry.parentID && unread(entry.id, inbox)
      ? "finished"
      : "idle",
  );
}
export function rollup(
  entries: readonly (IndexMetadata & OperationAttention)[],
  inbox: Pick<InboxSnapshot, "seen" | "finishes">,
): InboxStatus {
  const states = entries.map((entry) => inboxStatus(entry, inbox));
  return INBOX_STATUS_PRIORITY.find((status) => states.includes(status)) ??
    "idle";
}
export function visitTime(lastVisit: number, now: number): string {
  return relativeTime(lastVisit, now);
}
export function ageing(
  lastVisit: number,
  now: number,
  thresholds: readonly number[] = DEFAULT_PROJECT_AGEING,
): number {
  return thresholds.filter((threshold) => now - lastVisit >= threshold).length;
}
export interface InboxProject extends ProjectRecord {
  /** Older injected projections without a source are tracked projects. */
  source?: "tracked" | "index" | "template";
  status: InboxStatus;
  unread: boolean;
  visitText: string;
  ageing: number;
}
/** One projection shared by the column, collapsed rail and tab badges. */
export function inboxProjects(
  entries: readonly (IndexMetadata & OperationAttention)[],
  inbox: InboxSnapshot,
  now: number,
  thresholds?: readonly number[],
): InboxProject[] {
  const tracked = [...inbox.projects].sort((a, b) => a.order - b.order).map(
    (project) => {
      const sessions = entries.filter((entry) =>
        entry.directory === project.directory
      );
      const status = rollup(sessions, inbox);
      const inactive = project.inactive && status === "idle";
      const clock = inactive ? project.inactiveAt ?? project.lastVisit : now;
      return {
        ...project,
        source: "tracked" as const,
        inactive,
        status,
        unread: sessions.some((s) => !s.parentID && unread(s.id, inbox)),
        visitText: visitTime(project.lastVisit, clock),
        ageing: ageing(project.lastVisit, clock, thresholds),
      };
    },
  );
  const known = new Set(tracked.map((p) => p.directory));
  const indexed = new Map<string, IndexMetadata[]>();
  const latest = (sessions: readonly IndexMetadata[]) =>
    sessions.reduce((time, entry) => Math.max(time, entry.timeUpdated), 0);
  const byName = (a: string, b: string) =>
    projectName(a).localeCompare(projectName(b)) || a.localeCompare(b);
  for (const entry of entries) {
    if (known.has(entry.directory)) continue;
    const sessions = indexed.get(entry.directory) ?? [];
    sessions.push(entry);
    indexed.set(entry.directory, sessions);
  }
  const discovered = [...indexed].sort(([a, aa], [b, bb]) =>
    latest(bb) - latest(aa) || byName(a, b)
  ).map(([directory, sessions]): InboxProject => {
    known.add(directory);
    return {
      directory,
      source: "index",
      order: -latest(sessions),
      added: false,
      inactive: false,
      lastVisit: 0,
      status: rollup(sessions, inbox),
      unread: sessions.some((s) => !s.parentID && unread(s.id, inbox)),
      visitText: "",
      ageing: 0,
    };
  });
  const templates = [...new Set(inbox.discovered ?? [])].filter((p) =>
    !known.has(p)
  )
    .sort(byName).map((directory): InboxProject => ({
      directory,
      source: "template",
      order: 0,
      added: false,
      inactive: false,
      lastVisit: 0,
      status: "idle",
      unread: false,
      visitText: "",
      ageing: 0,
    }));
  return [...tracked, ...discovered, ...templates];
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
  projects: readonly string[];
  sessions: readonly string[];
  tasks: boolean;
  discovery: boolean;
}
export interface InboxModel {
  stop(): void;
  state: InboxState;
  subscribe(listener: (state: InboxState) => void): () => void;
  observeChanges(listener: (changes: InboxChanges) => void): () => void;
  receive(frame: ServerFrame): void;
  promote(session: TabSession, options?: RequestOptions): Promise<TaskRecord>;
  openProject(directory: string): Promise<void>;
  openSession(sessionID: string, directory: string): Promise<void>;
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
  let recoveryController: AbortController | undefined;
  let recovering: Promise<void> | undefined;
  let observed: { generation: string; revision: number } | undefined;
  const listeners = new Set<(changes: InboxChanges) => void>();
  const publish = (changes: InboxChanges) => {
    for (const listener of listeners) listener(changes);
  };
  const baseline = (value: InboxBaseline) => {
    if (generation !== undefined && value.generation !== generation) return;
    if (value.generation === generation && value.revision < revision) return;
    generation = value.generation;
    revision = value.revision;
    current.inbox = {
      ...value.inbox,
      projects: [...value.inbox.projects],
      tasks: [...value.inbox.tasks],
      seen: { ...value.inbox.seen },
      finishes: { ...value.inbox.finishes },
    };
    current.ready = true;
    clock.update((draft) => {
      draft.revision++;
    });
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
          observed && generation === observed.generation &&
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
        if (generation !== value.generation) generation = undefined;
        baseline(value);
        observed = undefined;
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
      case "templates":
        draft.pathTemplates = op.values;
        break;
      case "discovery":
        draft.discovered = op.directories;
        draft.discoveryError = op.failure
          ? "Project discovery is unavailable. Try again."
          : undefined;
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
    },
    state,
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
        recovering = undefined;
        observed = undefined;
      } else if (frame.t === "inbox.snapshot") {
        baseline(frame);
        if (
          observed && observed.generation === generation &&
          revision >= observed.revision
        ) {
          observed = undefined;
          recoveryController?.abort();
        }
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
        const projects = new Set<string>(), sessions = new Set<string>();
        let tasks = false, discovery = false;
        for (const op of frame.ops) {
          switch (op.op) {
            case "project.upsert":
              projects.add(op.project.directory);
              break;
            case "project.remove":
              projects.add(op.directory);
              break;
            case "seen":
            case "finish":
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
        publish({
          baseline: false,
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
    async openSession(sessionID: string, directory: string): Promise<void> {
      await rpc.call("projects.visit", { directory });
      await rpc.call("sessions.seen", { sessionID });
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
