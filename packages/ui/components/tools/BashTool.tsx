// SPDX-License-Identifier: LGPL-3.0-only
import { Show } from "solid-js";
import type { BashCall } from "@otk/protocol";
import ToolOutput from "./ToolOutput.tsx";
import type { ToolRegistry } from "../../registries/renderers.ts";
import { RunIcon } from "./ToolIcons.tsx";
export function registerBashTool(tools: ToolRegistry): void {
  tools.registerTyped(
    "bash",
    (props) => <BashTool call={props.call} directory={props.directory} />,
    (call) => ({
      icon: RunIcon,
      verb: "Run",
      target: call.command,
      summary: call.description,
    }),
  );
}
export default function BashTool(
  props: { call: BashCall; directory?: string },
) {
  return (
    <>
      <div class="otk-tool-summary otk-command">$ {props.call.command}</div>
      <Show
        when={props.call.cwd && props.call.cwd !== "." &&
          props.call.cwd !== props.directory}
      >
        <p class="otk-muted">
          Running in <span class="otk-path">{props.call.cwd}</span>
        </p>
      </Show>
      <ToolOutput text={props.call.output} limit={10} />
      <Show
        when={props.call.exitCode !== undefined && props.call.exitCode !== 0}
      >
        <small>Exit {props.call.exitCode}</small>
      </Show>
    </>
  );
}
