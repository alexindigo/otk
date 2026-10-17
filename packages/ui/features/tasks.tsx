// SPDX-License-Identifier: LGPL-3.0-only
import { createSignal } from "solid-js";
import type { DialogProps, DialogRegistry } from "../registries/shell.ts";
import Form from "../components/Form.tsx";
export interface TaskNameInput {
  name?: string;
  save(name: string): Promise<void>;
}
export function registerTaskDialogs(dialogs: DialogRegistry): void {
  dialogs.register<TaskNameInput>({
    id: "task-name",
    commandId: "task.name",
    title: (input) => input.name === undefined ? "New task" : "Rename task",
    component: TaskName,
  });
}
function TaskName(props: DialogProps) {
  const input = props.input as TaskNameInput;
  const [name, setName] = createSignal(input.name ?? "");
  return (
    <Form
      title="Task name"
      submitLabel="Save task"
      onSubmit={async () => {
        await input.save(name().trim());
        props.close();
      }}
    >
      <label>
        Name<input
          name="taskName"
          required
          value={name()}
          onInput={(e) => setName(e.currentTarget.value)}
        />
      </label>
    </Form>
  );
}
