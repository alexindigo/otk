// SPDX-License-Identifier: LGPL-3.0-only
import type { FetchCall } from "@otk/protocol";
import type { ToolRegistry } from "../../registries/renderers.ts";
import ToolOutput from "./ToolOutput.tsx";
export function registerFetchTool(tools: ToolRegistry): void {
  tools.registerTyped(
    "fetch",
    (props) => <FetchTool call={props.call} directory={props.directory} />,
    (call) => ({
      icon: "↓",
      verb: "Fetch",
      target: call.url,
      summary: call.format,
    }),
  );
}
export default function FetchTool(
  props: { call: FetchCall; directory?: string },
) {
  return (
    <ToolOutput
      text={props.call.output ?? ""}
      result={props.call.outputContent}
      directory={props.directory}
      limit={10}
    />
  );
}
