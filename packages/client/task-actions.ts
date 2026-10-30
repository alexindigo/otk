// SPDX-License-Identifier: LGPL-3.0-only
import type { TaskRecord } from "@otk/protocol";
import type { InboxRpc } from "./inbox.ts";
import type { RequestOptions } from "./requests.ts";
export interface TaskActions {
  create(name: string): Promise<TaskRecord>;
  rename(id: string, name: string): Promise<void>;
  reorder(ids: string[]): Promise<void>;
  close(id: string): Promise<void>;
  add(
    task: Pick<TaskRecord, "id">,
    sessionID: string,
    options?: RequestOptions,
  ): Promise<void>;
  remove(task: Pick<TaskRecord, "id">, sessionID: string): Promise<void>;
}
/** Capture the owning server/project before an asynchronous editor opens. */
export function createTaskActions(
  rpc: InboxRpc,
  directory: string,
): TaskActions {
  return {
    create: (name) =>
      rpc.intents
        ? rpc.intents.run(
          JSON.stringify(["create-task", directory, name]),
          (group) =>
            rpc.call(
              "tasks.create",
              { directory, name },
              group.options("create", directory),
            ),
        )
        : rpc.call("tasks.create", { directory, name }),
    async rename(id, name) {
      await rpc.call("tasks.rename", { id, name });
    },
    async reorder(ids) {
      await rpc.call("tasks.reorder", { directory, ids });
    },
    async close(id) {
      await rpc.call("tasks.close", { id });
    },
    async add(task, sessionID, options) {
      await rpc.call("tasks.addSession", {
        id: task.id,
        sessionID,
      }, options);
    },
    async remove(task, sessionID) {
      await rpc.call("tasks.removeSession", {
        id: task.id,
        sessionID,
      });
    },
  };
}
