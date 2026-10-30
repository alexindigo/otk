// SPDX-License-Identifier: LGPL-3.0-only
import type { RequestMetadata } from "./request-metadata.ts";
export const inboxRequestMetadata: Readonly<Record<string, RequestMetadata>> = {
  "inbox.get": { kind: "read", pending: "Loading projects" },
  "projects.list": { kind: "read", pending: "Loading projects" },
  "projects.add": { kind: "mutation", pending: "Creating project session" },
  "projects.inactive": { kind: "mutation", pending: "Saving project" },
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
};
/** Inbox metadata is server-local; callers pair it with their connection ID. */
export interface ProjectRecord {
  directory: string;
  order: number;
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
export interface InboxSnapshot {
  projects: ProjectRecord[];
  tasks: TaskRecord[];
  seen: Record<string, number>;
  finishes: Record<string, number>;
  pathTemplates: string[];
  /** Server-side template discovery; index discovery is projected from the index. */
  discovered?: string[];
  discoveryError?: string;
}
/** Feature-owned contracts, composed by the open RPC interface. */
export interface InboxRpcMethods {
  "inbox.get": { params: Record<string, never>; result: InboxSnapshot };
  "projects.list": { params: Record<string, never>; result: ProjectRecord[] };
  "projects.add": {
    params: { directory: string };
    result: ProjectRecord & { sessionID: string };
  };
  "projects.inactive": {
    params: { directory: string; inactive: boolean };
    result: ProjectRecord;
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
  "sessions.seen": { params: { sessionID: string }; result: number };
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
  "project-templates": string[];
  "session-seen": number;
}
