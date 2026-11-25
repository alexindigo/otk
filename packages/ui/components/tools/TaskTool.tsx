// SPDX-License-Identifier: LGPL-3.0-only
import { DelegateIcon } from "../ChromeIcons.tsx";
import "./TaskTool.css" with { type: "text" };
import { createMemo, Show } from "solid-js";
import type { TaskCall } from "@otk/protocol";
import { derivedValue } from "@otk/protocol";
import { type ActionControl, elapsed } from "@otk/client";
import { MetaText } from "../ChromeMeta.tsx";
import type { ToolRegistry } from "../../registries/renderers.ts";
import { useCommandPorts } from "../../keyboard/context.tsx";
import ActionButton from "../ActionButton.tsx";
import { sessionOpenControl } from "../session-open.ts";
import ToolOutput from "./ToolOutput.tsx";
import { countLabel } from "./count.ts";
export function registerTaskTool(tools: ToolRegistry): void {
  tools.registerTyped(
    "task",
    (props) => <TaskTool call={props.call} />,
    (call) => ({
      icon: DelegateIcon,
      verb: "Delegate",
      target: call.agent || "Unknown agent",
      entity: call.agent
        ? { label: call.agent, sessionID: call.childSessionID }
        : undefined,
      summary: call.description,
      category: "delegation",
    }),
  );
}
export default function TaskTool(
  props: { call: TaskCall; open?: ActionControl },
) {
  const { commands } = useCommandPorts();
  const open = createMemo(() =>
    props.open ??
      sessionOpenControl(
        commands,
        props.call.childSessionID ?? "",
        props.call.description ?? "Task",
      )
  );
  const progress = () => {
    const result = props.call.progress?.progress;
    const value = derivedValue(result);
    if (!value) {
      return result?.state === "pending"
        ? "Preparing progress..."
        : "Progress unavailable";
    }
    if (props.call.status === "running" && value.current) {
      return `${value.current.name} ${value.current.title ?? ""}`.trim();
    }
    const time = value.time;
    return (
      <MetaText
        items={[
          countLabel(value.toolCount!, "tool call"),
          time?.end !== undefined && elapsed(time.end - time.start),
        ]}
      />
    );
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
        <ActionButton
          action={open()}
          class="otk-task-card"
        >
          <strong>Open task</strong>
          <span>{progress()}</span>
        </ActionButton>
      </Show>
      <ToolOutput
        text={props.call.output ?? ""}
        result={props.call.outputContent}
      />
    </>
  );
}
