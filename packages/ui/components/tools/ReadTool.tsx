// SPDX-License-Identifier: LGPL-3.0-only
import { For } from "solid-js";
import type { ReadCall } from "@otk/protocol";
import type { ToolRegistry } from "../../registries/renderers.ts";
import { relativeTarget } from "./paths.ts";
import { FileIcon } from "./ToolIcons.tsx";
import ToolOutput from "./ToolOutput.tsx";
import ToolPath from "./ToolPath.tsx";
export function registerReadTool(tools: ToolRegistry): void {
  tools.registerTyped(
    "read",
    (props) => <ReadTool call={props.call} directory={props.directory} />,
    (call, context) => ({
      icon: FileIcon,
      verb: "Read",
      target: relativeTarget(call.path, context.directory),
      copy: { path: call.path },
      summary: [
        call.offset !== undefined ? `offset ${call.offset}` : "",
        call.limit !== undefined ? `limit ${call.limit}` : "",
      ].filter(Boolean).join(" · "),
    }),
  );
}
export default function ReadTool(
  props: { call: ReadCall; directory?: string },
) {
  return (
    <>
      <For each={props.call.loaded} keyed={false}>
        {(path) => (
          <div class="otk-muted">
            ↳ Loaded <ToolPath path={path()} directory={props.directory} />
          </div>
        )}
      </For>
      <ToolOutput
        text={props.call.output ?? ""}
        result={props.call.outputContent}
        directory={props.directory}
        limit={10}
      />
    </>
  );
}
