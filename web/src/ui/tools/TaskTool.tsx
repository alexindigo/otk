// SPDX-License-Identifier: LGPL-3.0-only
import { Show } from "solid-js";
import type { TaskCall } from "../../../../protocol/content.ts";
export default function TaskTool(
  props: { call: TaskCall; onOpen(id: string): void },
) {
  return (
    <button
      type="button"
      class="otk-task-card"
      disabled={!props.call.childSessionID}
      onClick={() =>
        props.call.childSessionID && props.onOpen(props.call.childSessionID)}
    >
      <strong>
        {props.call.agent[0]?.toUpperCase() + props.call.agent.slice(1)} Task —
        {" "}
        {props.call.description}
      </strong>
      <Show when={props.call.status === "running" && props.call.currentTool}>
        <span>↳ {props.call.currentTool}</span>
      </Show>
      <Show when={props.call.status === "completed"}>
        <span>
          {props.call.toolCount} tool calls{props.call.duration !== undefined
            ? ` · ${(props.call.duration / 1000).toFixed(1)}s`
            : ""}
        </span>
      </Show>
    </button>
  );
}
