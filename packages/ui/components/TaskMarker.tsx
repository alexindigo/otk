// SPDX-License-Identifier: LGPL-3.0-only
import { TaskStatusIcon } from "./ChromeIcons.tsx";
import "./TaskMarker.css" with { type: "text" };

/** Document status, never an inert form control or an available action. */
export default function TaskMarker(props: { done: boolean; class?: string }) {
  return (
    <span
      class={["otk-task-marker", props.class, { "is-done": props.done }]}
      role="img"
      aria-label={props.done ? "Done" : "Not done"}
    >
      <TaskStatusIcon checked={props.done} class="otk-task-marker-glyph" />
    </span>
  );
}
