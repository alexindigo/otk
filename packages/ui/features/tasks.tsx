// SPDX-License-Identifier: LGPL-3.0-only
import { createSignal } from "solid-js";
import type { DialogProps, DialogRegistry } from "../registries/shell.ts";
import CommandDialog from "../components/CommandDialog.tsx";
import Form from "../components/Form.tsx";
export interface TaskNameInput {
  name?: string;
  save(name: string): Promise<void>;
}
export function registerTaskDialogs(dialogs: DialogRegistry): void {
  dialogs.register({ id: "task-name", component: TaskName });
}
function TaskName(props: DialogProps) {
  const input = props.input as TaskNameInput;
  const [name, setName] = createSignal(input.name ?? "");
  return (
    <CommandDialog
      id="task.name"
      title={input.name === undefined ? "New task" : "Rename task"}
      onClose={props.close}
    >
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
    </CommandDialog>
  );
}
