// SPDX-License-Identifier: LGPL-3.0-only
import { For } from "solid-js";
import type { ReadCall } from "@otk/protocol";
import type { ToolRegistry } from "../../registries/renderers.ts";
export function registerReadTool(tools: ToolRegistry): void {
  tools.registerTyped(
    "read",
    (props) => <ReadTool call={props.call} />,
    (call) => ({
      icon: "▤",
      verb: "Read",
      target: call.path,
      summary: [
        call.offset !== undefined ? `offset ${call.offset}` : "",
        call.limit !== undefined ? `limit ${call.limit}` : "",
      ].filter(Boolean).join(" · "),
    }),
  );
}
export default function ReadTool(props: { call: ReadCall }) {
  return (
    <>
      <div class="otk-tool-summary">
        Read <span class="otk-path">{props.call.path}</span>
        {props.call.offset !== undefined
          ? ` · offset ${props.call.offset}`
          : ""}
        {props.call.limit !== undefined ? ` · limit ${props.call.limit}` : ""}
      </div>
      <For each={props.call.loaded} keyed={false}>
        {(path) => (
          <div class="otk-muted">
            ↳ Loaded <span class="otk-path">{path()}</span>
          </div>
        )}
      </For>
    </>
  );
}
