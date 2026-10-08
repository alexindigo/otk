// SPDX-License-Identifier: LGPL-3.0-only
import { For } from "solid-js";
import type { Todo as OtkTodo } from "../../../protocol/content.ts";
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
