// SPDX-License-Identifier: LGPL-3.0-only
import type { SearchCall } from "@otk/protocol";
import type { ToolRegistry } from "../../registries/renderers.ts";
import { relativeTarget } from "./paths.ts";
import { SearchIcon } from "../ChromeIcons.tsx";
export function registerSearchTool(tools: ToolRegistry): void {
  tools.registerTyped(
    "search",
    (props) => <SearchTool call={props.call} />,
    (call, context) => ({
      icon: SearchIcon,
      verb: call.mode === "list" ? "List" : "Search",
      target: call.pattern ||
        (call.path ? relativeTarget(call.path, context.directory) : undefined),
      summary: `${call.matches} ${
        call.mode === "list" ? "entries" : "matches"
      }`,
    }),
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
