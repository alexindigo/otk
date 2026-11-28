// SPDX-License-Identifier: LGPL-3.0-only
import type { RequestMetadata } from "./request-metadata.ts";
import type {
  BlockedCause,
  EntityCounts,
  EntityState,
  HelperDisposition,
} from "./entity-state.ts";
import type { PublicFailure } from "./requests.ts";
export const inboxRequestMetadata: Readonly<Record<string, RequestMetadata>> = {
  "inbox.get": { kind: "read", pending: "Loading projects" },
  "projects.list": { kind: "read", pending: "Loading projects" },
  "projects.add": { kind: "mutation", pending: "Creating project session" },
  "projects.inactive": { kind: "mutation", pending: "Saving project" },
  "projects.move": { kind: "mutation", pending: "Saving project order" },
  "programs.create": { kind: "mutation", pending: "Creating program" },
  "programs.rename": { kind: "mutation", pending: "Renaming program" },
  "programs.delete": { kind: "mutation", pending: "Deleting program" },
  "programs.move": { kind: "mutation", pending: "Saving program order" },
  "programs.assign": { kind: "mutation", pending: "Moving project" },
  "programs.auto": { kind: "mutation", pending: "Saving setting" },
  "projects.visit": {
    kind: "mutation",
    pending: "Saving project visit",
    presentation: "bookkeeping",
  },
  "projects.scan": { kind: "read", pending: "Finding projects" },
  "projects.templates": { kind: "mutation", pending: "Saving paths" },
  "tasks.list": { kind: "read", pending: "Loading tasks" },
  "tasks.create": { kind: "mutation", pending: "Creating task" },
  "tasks.rename": { kind: "mutation", pending: "Renaming task" },
  "tasks.reorder": { kind: "mutation", pending: "Saving task order" },
  "tasks.close": { kind: "mutation", pending: "Closing task" },
  "tasks.addSession": { kind: "mutation", pending: "Adding to task" },
  "tasks.removeSession": { kind: "mutation", pending: "Removing from task" },
  "tasks.sessions": { kind: "mutation", pending: "Saving task sessions" },
  "sessions.seen": {
    kind: "mutation",
    pending: "Saving viewed conversation",
    presentation: "bookkeeping",
  },
  "sessions.finishes": { kind: "read", pending: "Loading session activity" },
  "sessions.opened": {
    kind: "mutation",
    pending: "Saving open session",
    presentation: "bookkeeping",
  },
  "sessions.acknowledge": { kind: "mutation", pending: "Clearing attention" },
};
export type AcknowledgeScope = { scope: "helpers"; task: string } | {
  scope: "subtree";
  sessionID: string;
};
export interface AcknowledgedSessions {
  sessions: { sessionID: string; terminal: number; runID?: string }[];
  closed?: string[];
}
/** Inbox metadata is server-local; callers pair it with their connection ID. */
export interface ProjectRecord {
  directory: string;
  added: boolean;
  inactive: boolean;
  lastVisit: number;
  inactiveAt?: number;
}
export interface TaskRecord {
  id: string;
  directory: string;
  name: string;
  order: number;
  sessions: string[];
}
/** D78: one order for aggregate lamps. D7 navigation uses the same ranks. */
export const ROLLUP_PRIORITY = [
  "blocked",
  "finished",
  "working",
  "dependencies",
  "none",
] as const;
export type ProjectStatus = typeof ROLLUP_PRIORITY[number];
/** Combine published states for an aggregate lamp, never an individual session. */
export function rollupStatus(
  ...states: (ProjectStatus | undefined)[]
): ProjectStatus {
  return ROLLUP_PRIORITY.find((state) => states.includes(state)) ??
    "none";
}
/** Navigation ranks published session states; membership and ties are its own. */
export const urgentStatus = rollupStatus;

/** Fold the entity owner's incremental counts, including direct checkout inputs. */
export function aggregateTransition(
  { counts, forms, graced, dependencies, operation }: {
    counts: EntityCounts;
    forms: number;
    graced: number;
    dependencies: number;
    operation?: "working" | "blocked";
  },
): {
  rule: string;
  state: ProjectStatus;
  cause?: BlockedCause;
  liveWork: boolean;
} {
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
    : !forms && operation !== "blocked" && graced === counts.blocked
    ? "permission"
    : undefined;
  return {
    rule: cause ? `aggregate.${cause}` : `aggregate.${state}`,
    state,
    cause,
    liveWork: counts.working > 0 || operation === "working",
  };
}

/** Helper group lamps describe the disposition, not each session's own lamp. */
export const HELPER_LAMP_STATE = {
  needsYou: "blocked",
  running: "working",
  finished: "finished",
  opened: "none",
} as const satisfies Record<HelperDisposition, ProjectStatus>;
export const HELPER_LAMP_ORDER: readonly HelperDisposition[] =
  (Object.keys(HELPER_LAMP_STATE) as HelperDisposition[]).sort((a, b) =>
    ROLLUP_PRIORITY.indexOf(HELPER_LAMP_STATE[a]) -
    ROLLUP_PRIORITY.indexOf(HELPER_LAMP_STATE[b])
  );
/**
 * Reserved `canonicalRoot` of a removed checkout whose repository cannot be
 * determined. Not a path, so it can never name a project row.
 */
export const UNKNOWN_REPOSITORY = "otk:unknown-repository";
/** Connection-local repository identity; checkout roots are explicit native facts. */
export interface ProjectTopology {
  /** Native repository ID, independent of the sidebar group. */
  repoID: string;
  /** Identity owner's group key. Legacy/injected topology can omit it. */
  group?: string;
  /** The project's anchor, or `UNKNOWN_REPOSITORY`. */
  canonicalRoot: string;
  leafDirectory: string;
  /** Absent for the canonical checkout's direct leaf. */
  parentDirectory?: string;
}
export const projectTopologyGroup = (
  topology?: ProjectTopology,
): string | undefined =>
  topology && (topology.group ?? `repo:${topology.repoID}`);
export const remoteProjectGroup = (
  topology?: ProjectTopology,
): string | undefined =>
  topology?.group !== `repo:${topology?.repoID}` ? topology?.group : undefined;
export interface ProjectSummaryFacts {
  presentation?: Pick<
    import("./catalogs/project.ts").CatalogProject,
    "id" | "name" | "color"
  >;
  /** Running PTYs in this checkout, including those with a deleted owner. */
  dependencies?: number;
  /** Pending location-owned forms; not fabricated sessions or session counts. */
  locationForms?: number;
  directory: string;
  /** Population authority, independent of acquired session membership. */
  hasSessions?: boolean;
  status: ProjectStatus | null;
  sessionCount: number | null;
  unseenCount: number | null;
  lastActivity: number | null;
  authority: "current" | "stale" | "unknown";
}
export interface ProjectSummary extends ProjectSummaryFacts {
  topology?: ProjectTopology;
  /** Availability is independent of durable affiliation and activity policy. */
  availability?: "present" | "removed" | "unknown";
  /** Proven removed worktree; independent of manual inactive policy and lamps. */
  archived?: boolean;
  /** Exact native owners, including several repositories sharing one path. */
  memberships?: readonly {
    source: string;
    repoID: string;
    directory: string;
    leafDirectory: string;
    availability: "present" | "removed" | "unknown";
    kind: "checkout" | "worktree" | "unknown";
    inventory?: "current" | "unknown";
  }[];
  /** Exact native list/task scopes owned by this checkout, never rewritten paths. */
  scopes?: readonly string[];
  /** Canonical rows roll up the repo; direct retains only that checkout. */
  direct?: ProjectSummaryFacts;
}
export interface InboxSnapshot {
  projects: ProjectRecord[];
  tasks: TaskRecord[];
  seen: Record<string, number>;
  finishes: Record<string, number>;
  /** Per-user server projection; consumers never reconstruct it from status. */
  supervision?: Record<string, import("./supervision.ts").Supervision>;
  pathTemplates: string[];
  /** Server-side template discovery; index discovery is projected from the index. */
  discovered?: string[];
  discoveryError?: string;
  discoveryFailure?: PublicFailure;
  /** Additive server-owned scalar projection; no session data is needed by rows. */
  summaries?: Record<string, ProjectSummary>;
  /** Per-user single state model, keyed by entityKey(kind, id). */
  entities?: Record<string, EntityState>;
}
export interface InboxVersion {
  generation: string;
  revision: number;
}
export interface InboxBaseline extends InboxVersion {
  epoch?: number;
  inbox: InboxSnapshot;
  summaryRevision?: number;
}
export type InboxOp =
  | { op: "entity.upsert"; value: EntityState }
  | { op: "entity.remove"; key: string }
  | { op: "project.upsert"; project: ProjectRecord }
  | { op: "project.remove"; directory: string }
  | { op: "task.upsert"; task: TaskRecord }
  | { op: "task.remove"; id: string }
  | { op: "seen"; sessionID: string; time: number }
  | { op: "finish"; sessionID: string; time: number }
  | {
    op: "supervision";
    sessionID: string;
    value: import("./supervision.ts").Supervision | null;
  }
  | { op: "templates"; values: string[] }
  | { op: "discovery"; directories: string[]; failure?: PublicFailure };
/** Feature-owned contracts, composed by the open RPC interface. */
export interface InboxRpcMethods {
  "inbox.get": { params: Record<string, never>; result: InboxBaseline };
  "projects.list": { params: Record<string, never>; result: ProjectRecord[] };
  "projects.add": {
    params: { directory: string };
    result: ProjectRecord & { sessionID: string };
  };
  "projects.inactive": {
    params: { directory: string; inactive: boolean };
    result: ProjectRecord;
  };
  "projects.move": {
    params: import("./project-order.ts").ProjectMove;
    result: { revision: number };
  };
  "programs.create": {
    params: import("./programs.ts").ProgramCreate;
    result: { id: string; revision: number };
  };
  "programs.rename": {
    params: { id: string; name: string };
    result: { revision: number };
  };
  "programs.delete": {
    params: { id: string };
    result: { revision: number };
  };
  "programs.move": {
    params: import("./programs.ts").ProgramMove;
    result: { revision: number };
  };
  "programs.assign": {
    params: import("./programs.ts").ProgramAssign;
    result: { revision: number; orderRevision: number };
  };
  "programs.auto": {
    params: { value: boolean };
    result: { revision: number };
  };
  "projects.visit": {
    params: { directory: string; active?: boolean };
    result: ProjectRecord | null;
  };
  "projects.scan": { params: Record<string, never>; result: string[] };
  "projects.templates": { params: { templates: string[] }; result: string[] };
  "tasks.list": { params: { directory?: string }; result: TaskRecord[] };
  "tasks.create": {
    params: { directory: string; name: string; sessions?: string[] };
    result: TaskRecord;
  };
  "tasks.rename": { params: { id: string; name: string }; result: TaskRecord };
  "tasks.reorder": {
    params: { directory: string; ids: string[] };
    result: TaskRecord[];
  };
  "tasks.close": { params: { id: string }; result: null };
  "tasks.addSession": {
    params: { id: string; sessionID: string };
    result: TaskRecord;
  };
  "tasks.removeSession": {
    params: { id: string; sessionID: string };
    result: TaskRecord;
  };
  /** Intentional complete replacement, not an add/remove intent. */
  "tasks.sessions": {
    params: { id: string; sessions: string[] };
    result: TaskRecord;
  };
  "sessions.seen": {
    params: { sessionID: string; terminal: number; runID?: string };
    result: number;
  };
  "sessions.opened": {
    params: { sessionID: string; opened: boolean };
    result: boolean;
  };
  "sessions.acknowledge": {
    params: AcknowledgeScope;
    result: AcknowledgedSessions;
  };
  "sessions.finishes": {
    params: Record<string, never>;
    result: Record<string, number>;
  };
}

export interface InboxRequestReceipts {
  "project-session": ProjectRecord & { sessionID: string };
  task: TaskRecord;
  tasks: TaskRecord[];
  "task-closed": { taskID: string; closed: true };
  project: ProjectRecord;
  "project-visit": ProjectRecord | null;
  "project-order-move": true;
  "program-created": string;
  "program-changed": true;
  "project-templates": string[];
  "session-seen": number;
  "session-opened": boolean;
  "session-acknowledge": AcknowledgedSessions;
}
