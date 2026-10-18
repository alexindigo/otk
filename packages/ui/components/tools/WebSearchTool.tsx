// SPDX-License-Identifier: LGPL-3.0-only
import type { WebSearchCall } from "@otk/protocol";
import type { ToolRegistry } from "../../registries/renderers.ts";
import ToolOutput from "./ToolOutput.tsx";
export function registerWebSearchTool(tools: ToolRegistry): void {
  tools.registerTyped(
    "websearch",
    (props) => <WebSearchTool call={props.call} />,
    (call) => ({
      icon: "⌕",
      verb: "Search web",
      target: call.query,
      summary: call.provider,
    }),
  );
}
export default function WebSearchTool(props: { call: WebSearchCall }) {
  return (
    <ToolOutput
      text={props.call.output ?? ""}
      result={props.call.outputContent}
      limit={10}
    />
  );
}
