// SPDX-License-Identifier: LGPL-3.0-only
import "./Todo.css" with { type: "text" };
import type { ToolRegistry } from "../registries/renderers.ts";
import { countLabel } from "./tools/count.ts";
export function registerTodoTool(tools: ToolRegistry): void {
  tools.registerTyped(
    "todo",
    (props) => <Todo items={props.call.items} />,
    (call) => ({
      icon: "☑",
      verb: "Update tasks",
      summary: `${
        call.items.filter((item) => item.status === "completed").length
      }/${countLabel(call.items.length, "task")} completed`,
    }),
  );
}
import { For } from "solid-js";
import type { Todo as OtkTodo } from "@otk/protocol";
export default function Todo(props: { items: OtkTodo[] }) {
  return (
    <ul class="otk-todos" aria-label="Todos">
      <For each={props.items} keyed={false}>
        {(item) => (
          <li data-todo-status={item().status}>
            <span aria-hidden="true">
              [{item().status === "completed"
                ? "✓"
                : item().status === "in_progress"
                ? "•"
                : " "}]
            </span>
            <span>{item().content}</span>
          </li>
        )}
      </For>
    </ul>
  );
}
