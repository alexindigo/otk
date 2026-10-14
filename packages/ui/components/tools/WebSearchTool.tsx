// SPDX-License-Identifier: LGPL-3.0-only
import type { WebSearchCall } from "@otk/protocol";
import type { ToolRegistry } from "../../registries/renderers.ts";
export function registerWebSearchTool(tools: ToolRegistry): void {
  tools.register(
    "websearch",
    (props) => <WebSearchTool call={props.call} />,
    (call) => call.tool === "websearch",
  );
}
export default function WebSearchTool(props: { call: WebSearchCall }) {
  return (
    <div class="otk-tool-summary">
      {props.call.provider ? `${props.call.provider} Web Search` : "Web Search"}
      {" "}
      "{props.call.query}"
    </div>
  );
}
