// SPDX-License-Identifier: LGPL-3.0-only
import type { SearchCall } from "@otk/protocol";
import type { ToolRegistry } from "../../registries/renderers.ts";
export function registerSearchTool(tools: ToolRegistry): void {
  tools.register(
    "search",
    (props) => <SearchTool call={props.call} />,
    (call) => call.tool === "search",
  );
}
export default function SearchTool(props: { call: SearchCall }) {
  return (
    <div class="otk-tool-summary" data-search-mode={props.call.mode}>
      {props.call.mode[0].toUpperCase() + props.call.mode.slice(1)}{" "}
      {props.call.mode !== "list" ? `"${props.call.pattern}" ` : ""}
      {props.call.path ? `in ${props.call.path} ` : ""}({props.call.matches}
      {" "}
      {props.call.mode === "list" ? "entries" : "matches"})
    </div>
  );
}
