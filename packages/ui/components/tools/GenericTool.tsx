// SPDX-License-Identifier: LGPL-3.0-only
import { Show } from "solid-js";
import type { ExternalCall } from "@otk/protocol";
import ToolOutput from "./ToolOutput.tsx";
import type { ToolRegistry } from "../../registries/renderers.ts";
export function registerGenericTool(tools: ToolRegistry): void {
  tools.fallback((props) => (
    <GenericTool
      call={props.call as ExternalCall}
      output={props.genericOutput}
    />
  ));
}
export default function GenericTool(
  props: { call: ExternalCall; output: boolean },
): import("solid-js").Element {
  return (
    <>
      <Show when={props.output}>
        <ToolOutput text={props.call.output || ""} limit={3} />
        <Show when={props.call.outputTruncated}>
          <small>Output truncated.</small>
        </Show>
      </Show>
    </>
  );
}
