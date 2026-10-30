// SPDX-License-Identifier: LGPL-3.0-only
import type { ProjectRecord, TaskRecord } from "@otk/protocol";
import { isSessionID } from "@otk/protocol";
import { object, sessionID, text } from "../ws/params.ts";
import { metadataReceipt } from "../requests/policies.ts";

function number(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new TypeError("Invalid metadata number");
  }
  return value;
}
function strings(value: unknown): string[] {
  if (
    !Array.isArray(value) || !value.every((item) => typeof item === "string")
  ) {
    throw new TypeError("Invalid metadata strings");
  }
  return [...value];
}
function task(value: unknown): TaskRecord {
  const row = object(value), sessions = strings(row.sessions);
  if (!sessions.every(isSessionID)) {
    throw new TypeError("Invalid session references");
  }
  return {
    id: text(row, "id")!,
    directory: text(row, "directory")!,
    name: text(row, "name")!,
    order: number(row.order),
    sessions,
  };
}
function project(value: unknown): ProjectRecord {
  const row = object(value);
  if (typeof row.added !== "boolean" || typeof row.inactive !== "boolean") {
    throw new TypeError("Invalid project metadata");
  }
  return {
    directory: text(row, "directory")!,
    order: number(row.order),
    added: row.added,
    inactive: row.inactive,
    lastVisit: number(row.lastVisit),
    ...(row.inactiveAt === undefined
      ? {}
      : { inactiveAt: number(row.inactiveAt) }),
  };
}
export const taskReceipt = metadataReceipt("task", task);
export const tasksReceipt = metadataReceipt("tasks", (value) => {
  if (!Array.isArray(value)) throw new TypeError("Invalid task metadata");
  return value.map(task);
});
export const closedReceipt = metadataReceipt("task-closed", (value) => {
  const row = object(value);
  if (row.closed !== true) throw new TypeError("Invalid close receipt");
  return { taskID: text(row, "taskID")!, closed: true };
});
export const projectReceipt = metadataReceipt("project", project);
export const projectSessionReceipt = metadataReceipt(
  "project-session",
  (value) => {
    const row = object(value), id = sessionID(row)!;
    if (!isSessionID(id)) {
      throw new TypeError(
        "Invalid project session receipt",
      );
    }
    return { ...project(value), sessionID: id };
  },
);
export const visitReceipt = metadataReceipt(
  "project-visit",
  (value) => value === null ? null : project(value),
);
export const templatesReceipt = metadataReceipt("project-templates", strings);
export const seenReceipt = metadataReceipt("session-seen", number);
