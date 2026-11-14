// SPDX-License-Identifier: LGPL-3.0-only
import "./TaskTool.css" with { type: "text" };
import { Show } from "solid-js";
import type { TaskCall } from "@otk/protocol";
import { derivedValue } from "@otk/protocol";
import { duration } from "@otk/client";
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
  const progress = () => {
    const result = props.call.progress?.progress;
    const value = derivedValue(result);
    if (!value) {
      return result?.state === "pending"
        ? "Preparing progress\u2026"
        : "Progress unavailable";
    }
    if (props.call.status === "running" && value.current) {
      return `↳ ${value.current.name} ${value.current.title ?? ""}`.trim();
    }
    const time = value.time;
    return `${countLabel(value.toolCount!, "tool call")}${
      time?.end !== undefined ? ` · ${duration(time.end - time.start)}` : ""
    }`;
  };
  return (
    <>
      <Show
        when={props.call.childSessionID}
        fallback={
          <div class="otk-task-card">
            <span>{progress()}</span>
          </div>
        }
      >
        <button
          type="button"
          class="otk-task-card"
          onClick={() => void open()}
        >
          <strong>Open task</strong>
          <span>{progress()}</span>
        </button>
      </Show>
      <ToolOutput
        text={props.call.output ?? ""}
        result={props.call.outputContent}
      />
    </>
  );
}
