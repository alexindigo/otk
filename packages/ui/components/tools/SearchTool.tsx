// SPDX-License-Identifier: LGPL-3.0-only
import type { SearchCall } from "@otk/protocol";
import type { ToolRegistry } from "../../registries/renderers.ts";
export function registerSearchTool(tools: ToolRegistry): void {
  tools.registerTyped(
    "search",
    (props) => <SearchTool call={props.call} />,
  );
}
export default function SearchTool(props: { call: SearchCall }) {
  return (
    <div class="otk-tool-summary" data-search-mode={props.call.mode}>
      {props.call.mode[0].toUpperCase() + props.call.mode.slice(1)}{" "}
      {props.call.mode !== "list" ? `"${props.call.pattern}" ` : ""}
      {props.call.path
        ? (
          <>
            in <span class="otk-path">{props.call.path}</span>
            {" "}
          </>
        )
        : ""}({props.call.matches}{" "}
      {props.call.mode === "list" ? "entries" : "matches"})
    </div>
  );
}
