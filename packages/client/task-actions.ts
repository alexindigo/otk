// SPDX-License-Identifier: LGPL-3.0-only
import type { TaskRecord } from "@otk/protocol";
import type { InboxRpc } from "./inbox.ts";
export interface TaskActions {
  create(name: string): Promise<TaskRecord>;
  rename(id: string, name: string): Promise<void>;
  reorder(ids: string[]): Promise<void>;
  close(id: string): Promise<void>;
  add(task: TaskRecord, sessionID: string): Promise<void>;
}
/** Capture the owning server/project before an asynchronous editor opens. */
export function createTaskActions(
  rpc: InboxRpc,
  directory: string,
): TaskActions {
  return {
    create: (name) => rpc.call("tasks.create", { directory, name }),
    async rename(id, name) {
      await rpc.call("tasks.rename", { id, name });
    },
    async reorder(ids) {
      await rpc.call("tasks.reorder", { directory, ids });
    },
    async close(id) {
      await rpc.call("tasks.close", { id });
    },
    async add(task, sessionID) {
      await rpc.call("tasks.sessions", {
        id: task.id,
        sessions: [...task.sessions, sessionID],
      });
    },
  };
}
