// SPDX-License-Identifier: LGPL-3.0-only
import { For } from "solid-js";
import type { ReadCall } from "@otk/protocol";
import type { ToolRegistry } from "../../registries/renderers.ts";
export function registerReadTool(tools: ToolRegistry): void {
  tools.registerTyped(
    "read",
    (props) => <ReadTool call={props.call} />,
  );
}
export default function ReadTool(props: { call: ReadCall }) {
  return (
    <>
      <div class="otk-tool-summary">
        Read {props.call.path}
        {props.call.offset !== undefined
          ? ` · offset ${props.call.offset}`
          : ""}
        {props.call.limit !== undefined ? ` · limit ${props.call.limit}` : ""}
      </div>
      <For each={props.call.loaded} keyed={false}>
        {(path) => <div class="otk-muted">↳ Loaded {path()}</div>}
      </For>
    </>
  );
}
