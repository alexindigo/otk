// SPDX-License-Identifier: LGPL-3.0-only
import { Show } from "solid-js";
import type { ToolCall } from "../../../protocol/content.ts";
export default function ToolLine(props: { call: ToolCall }) {
  return (
    <div class="otk-tool-line" data-tool-status={props.call.status}>
      <span>
        {props.call.tool === "generic" ? props.call.name : props.call.tool} ·
        {" "}
        {props.call.status} ·{" "}
        {props.call.title || (props.call.tool === "generic"
          ? props.call.summary
          : props.call.description || props.call.command)}
      </span>
      <Show when={props.call.error}>
        <span class="otk-error">{props.call.error}</span>
      </Show>
    </div>
  );
}
