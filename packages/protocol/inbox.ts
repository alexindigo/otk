// SPDX-License-Identifier: LGPL-3.0-only
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
}
/** Feature-owned contracts, composed by the open RPC interface. */
export interface InboxRpcMethods {
  "inbox.get": { params: Record<string, never>; result: InboxSnapshot };
  "projects.list": { params: Record<string, never>; result: ProjectRecord[] };
  "projects.add": { params: { directory: string }; result: ProjectRecord };
  "projects.inactive": {
    params: { directory: string; inactive: boolean };
    result: ProjectRecord;
  };
  "projects.visit": { params: { directory: string }; result: ProjectRecord };
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
