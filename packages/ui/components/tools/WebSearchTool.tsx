// SPDX-License-Identifier: LGPL-3.0-only
import { SearchIcon } from "../ChromeIcons.tsx";
import type { WebSearchCall } from "@otk/protocol";
import type { ToolRegistry } from "../../registries/renderers.ts";
import ToolOutput from "./ToolOutput.tsx";
export function registerWebSearchTool(tools: ToolRegistry): void {
  tools.registerTyped(
    "websearch",
    (props) => <WebSearchTool call={props.call} />,
    (call) => ({
      icon: SearchIcon,
      verb: "Search web",
      runs: { noun: "web search", plural: "web searches" },
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
    />
  );
}
