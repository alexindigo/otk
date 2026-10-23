// SPDX-License-Identifier: LGPL-3.0-only
import "./TaskTool.css" with { type: "text" };
import { Show } from "solid-js";
import type { TaskCall } from "@otk/protocol";
import type { ToolRegistry } from "../../registries/renderers.ts";
import { ownedAction } from "../../keyboard/context.tsx";
import ToolOutput from "./ToolOutput.tsx";
import { countLabel } from "./count.ts";
export function registerTaskTool(tools: ToolRegistry): void {
  tools.registerTyped(
    "task",
    (props) => <TaskTool call={props.call} onOpen={props.onOpenChild} />,
    (call) => ({
      icon: "↳",
      verb: "Delegate",
      target: call.agent || "Unknown agent",
      summary: call.description,
      expanded: true,
    }),
  );
}
export default function TaskTool(
  props: { call: TaskCall; onOpen(id: string): void },
) {
  const open = ownedAction("task.open", () => {
    if (props.call.childSessionID) props.onOpen(props.call.childSessionID);
  });
  return (
    <>
      <button
        type="button"
        class="otk-task-card"
        disabled={!props.call.childSessionID}
        onClick={() => void open()}
      >
        <strong>Open task</strong>
        <Show when={props.call.status === "running" && props.call.currentTool}>
          <span>↳ {props.call.currentTool}</span>
        </Show>
        <Show when={props.call.status === "completed"}>
          <span>
            {countLabel(props.call.toolCount, "tool call")}
            {props.call.duration !== undefined
              ? ` · ${(props.call.duration / 1000).toFixed(1)}s`
              : ""}
          </span>
        </Show>
      </button>
      <ToolOutput
        text={props.call.output ?? ""}
        result={props.call.outputContent}
        limit={10}
      />
    </>
  );
}
