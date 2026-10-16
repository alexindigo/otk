// SPDX-License-Identifier: LGPL-3.0-only
import { DEFAULT_PROJECT_AGEING } from "@otk/protocol";
import type {
  InboxSnapshot,
  IndexEntry,
  ProjectRecord,
  RpcMethod,
  RpcParams,
  RpcResult,
  ServerFrame,
  TaskRecord,
} from "@otk/protocol";
import { createState, type StateFactory } from "./state.ts";
import type { TabSession } from "./tabs.ts";
export type InboxStatus = "blocked" | "working" | "finished" | "idle";
export function unread(
  sessionID: string,
  inbox: Pick<InboxSnapshot, "seen" | "finishes">,
): boolean {
  return (inbox.finishes[sessionID] ?? 0) > (inbox.seen[sessionID] ?? 0);
}
export function inboxStatus(
  entry: IndexEntry,
  inbox: Pick<InboxSnapshot, "seen" | "finishes">,
): InboxStatus {
  const a = entry.attention;
  if (
    a.error ||
    a.permissions + a.questions + a.childPermissions + a.childQuestions > 0
  ) return "blocked";
  if (entry.status !== "idle") return "working";
  return unread(entry.id, inbox) ? "finished" : "idle";
}
export function rollup(
  entries: readonly IndexEntry[],
  inbox: Pick<InboxSnapshot, "seen" | "finishes">,
): InboxStatus {
  const states = entries.map((entry) => inboxStatus(entry, inbox));
  return (["blocked", "working", "finished", "idle"] as const).find((status) =>
    states.includes(status)
  ) ?? "idle";
}
export function visitTime(lastVisit: number, now: number): string {
  const minutes = Math.floor(Math.max(0, now - lastVisit) / 60_000);
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24), rest = hours % 24;
  return `${days}d${rest ? ` ${rest}h` : ""}`;
}
export function ageing(
  lastVisit: number,
  now: number,
  thresholds: readonly number[] = DEFAULT_PROJECT_AGEING,
): number {
  return thresholds.filter((threshold) => now - lastVisit >= threshold).length;
}
export interface InboxProject extends ProjectRecord {
  status: InboxStatus;
  unread: boolean;
  visitText: string;
  ageing: number;
}
/** One projection shared by the column, collapsed rail and tab badges. */
export function inboxProjects(
  entries: readonly IndexEntry[],
  inbox: InboxSnapshot,
  now: number,
  thresholds?: readonly number[],
): InboxProject[] {
  return [...inbox.projects].sort((a, b) => a.order - b.order).map(
    (project) => {
      const sessions = entries.filter((entry) =>
        entry.directory === project.directory
      );
      const status = rollup(sessions, inbox);
      const inactive = project.inactive && status === "idle";
      const clock = inactive ? project.inactiveAt ?? project.lastVisit : now;
      return {
        ...project,
        inactive,
        status,
        unread: sessions.some((s) => unread(s.id, inbox)),
        visitText: visitTime(project.lastVisit, clock),
        ageing: ageing(project.lastVisit, clock, thresholds),
      };
    },
  );
}
export interface InboxRpc {
  call<M extends RpcMethod>(
    method: M,
    params: RpcParams<M>,
  ): Promise<RpcResult<M>>;
}
export interface InboxState {
  inbox: InboxSnapshot;
}
export interface InboxModel {
  state: InboxState;
  subscribe(listener: (state: InboxState) => void): () => void;
  receive(frame: ServerFrame): void;
  promote(session: TabSession): Promise<TaskRecord>;
  openProject(directory: string): Promise<void>;
  openSession(sessionID: string, directory: string): Promise<void>;
  act<T>(directory: string, action: () => Promise<T>): Promise<T>;
}
/** Connection-local model; the caller owns routing, clock scheduling and errors. */
export function createInbox(
  rpc: InboxRpc,
  factory: StateFactory = createState,
): InboxModel {
  const store = factory<{ inbox: InboxSnapshot }>({
    inbox: {
      projects: [],
      tasks: [],
      seen: {},
      finishes: {},
      pathTemplates: [],
    },
  });
  return {
    state: store.state,
    subscribe: store.subscribe,
    /** Atomic server-side promotion, suitable as createTabs' injected port. */
    promote(session: TabSession) {
      return rpc.call("tasks.create", {
        directory: session.directory,
        name: session.title || "Session",
        sessions: [session.id],
      });
    },
    receive(frame: ServerFrame): void {
      if (frame.t === "inbox") {
        store.update((draft) => store.reconcile(draft.inbox, frame.inbox));
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
    async act<T>(directory: string, action: () => Promise<T>): Promise<T> {
      const result = await action();
      await rpc.call("projects.visit", { directory });
      return result;
    },
  };
}
