// SPDX-License-Identifier: LGPL-3.0-only
import type { ClientTabs, CommandHub, TaskActions } from "@otk/client";
import type { TaskRecord } from "@otk/protocol";

/** Task control handlers outlive any particular menu or button presentation. */
export function createTaskControls(ports: {
  commands: Pick<CommandHub, "run">;
  signal: AbortSignal;
  actions(): TaskActions;
  model(): ClientTabs;
  tasks(): readonly TaskRecord[];
  onEmpty(): boolean;
}) {
  return {
    pin: (id: string) => ports.model().pin(id),
    rename(task?: TaskRecord) {
      const actions = ports.actions(),
        model = ports.model(),
        signal = ports.signal;
      return ports.commands.run("dialog.open", {
        id: "task-name",
        input: {
          name: task?.name,
          save: async (name: string) => {
            if (task) await actions.rename(task.id, name);
            else {
              const created = await actions.create(name);
              if (
                !signal.aborted && ports.model() === model &&
                await model.taskReady(created.id, signal) &&
                !signal.aborted &&
                ports.model() === model && ports.onEmpty()
              ) {
                model.select({ kind: "task", id: created.id });
              }
            }
          },
        },
      });
    },
    async move(input: { task: TaskRecord; delta: number }) {
      const ids = ports.tasks().filter((t) =>
          t.directory === input.task.directory
        ).map((t) => t.id),
        from = ids.indexOf(input.task.id),
        to = from + input.delta;
      if (to < 0 || to >= ids.length) return;
      [ids[from], ids[to]] = [ids[to], ids[from]];
      await ports.actions().reorder(ids);
    },
    close: (id: string) => ports.actions().close(id),
    add: (input: { task: TaskRecord; sessionID: string }) =>
      ports.actions().add(input.task, input.sessionID),
  };
}
