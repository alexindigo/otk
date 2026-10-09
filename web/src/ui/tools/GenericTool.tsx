// SPDX-License-Identifier: LGPL-3.0-only
import { Show } from "solid-js";
import type { GenericCall } from "../../../../protocol/content.ts";
import ToolOutput from "./ToolOutput.tsx";
export default function GenericTool(
  props: { call: GenericCall; output: boolean },
) {
  return (
    <>
      <div class="otk-tool-summary">{props.call.name} {props.call.summary}</div>
      <Show when={props.output}>
        <ToolOutput text={props.call.output || ""} limit={3} />
        <Show when={props.call.outputTruncated}>
          <small>Output truncated at 64 KiB by the sidecar.</small>
        </Show>
      </Show>
    </>
  );
}
