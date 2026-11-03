// SPDX-License-Identifier: LGPL-3.0-only
import {
  type IndexMetadata,
  type RequestMetadataRegistry,
  sessionAncestors,
  type TaskRecord,
} from "@otk/protocol";
import {
  attentionStatus,
  type InboxProject,
  type InboxStatus,
  type OperationAttention,
} from "./inbox.ts";
import type { Operation } from "./requests.ts";

/** Browser operation attention decorates projections, never native index facts. */
export function requestAttention(
  operations: readonly Operation<unknown>[],
  metadata: RequestMetadataRegistry,
  entries: readonly IndexMetadata[],
  tasks: readonly TaskRecord[],
): {
  entries<T extends IndexMetadata>(
    values: readonly T[],
  ): (T & OperationAttention)[];
  projects(values: readonly InboxProject[]): InboxProject[];
  tasks: Readonly<Record<string, InboxStatus>>;
} {
  const sessions = new Map(entries.map((entry) => [entry.id, entry]));
  const byTask = new Map(tasks.map((task) => [task.id, task]));
  const sessionStates = new Map<string, InboxStatus>(),
    projectStates = new Map<string, InboxStatus>();
  const taskStates: Record<string, InboxStatus> = {};
  const add = (
    map: Map<string, InboxStatus>,
    key: string,
    status: InboxStatus,
  ) => map.set(key, attentionStatus(map.get(key), status));
  const addSession = (id: string, status: InboxStatus) => {
    if (!sessions.get(id)?.deleted) add(sessionStates, id, status);
  };
  for (const operation of operations) {
    const state = operation.state, owner = state.owner;
    if (
      !owner || metadata.get(state.method)?.kind !== "mutation" ||
      state.phase === "succeeded" || state.phase === "released"
    ) continue;
    // Automatic bookkeeping has diagnostics, but never work for the user to
    // supervise. Its failure must not promote a session/project into attention.
    if (metadata.get(state.method)?.presentation === "bookkeeping") continue;
    const session = sessions.get(owner), task = byTask.get(owner);
    // Authoritative lifetime facts outrank every retained operation receipt,
    // regardless of whether the operation settles before or after deletion.
    if (session?.deleted) continue;
    const status =
      state.error || state.connection === "authentication-required" ||
        state.progress?.code === "input-required"
        ? "blocked"
        : "working";
    add(projectStates, session?.directory ?? task?.directory ?? owner, status);
    if (task) {
      taskStates[task.id] = attentionStatus(taskStates[task.id], status);
      for (const id of task.sessions) addSession(id, status);
    }
    if (session) {
      for (
        const id of [
          owner,
          ...sessionAncestors(owner, (id) => sessions.get(id)),
        ]
      ) addSession(id, status);
    }
  }
  return {
    entries: (values) =>
      values.map((entry) =>
        sessionStates.has(entry.id)
          ? { ...entry, operationStatus: sessionStates.get(entry.id) }
          : entry
      ),
    projects: (values) =>
      values.map((project) => {
        const status = attentionStatus(
          project.status,
          projectStates.get(project.directory),
        );
        return status === project.status
          ? project
          : { ...project, status, inactive: false };
      }),
    tasks: taskStates,
  };
}
