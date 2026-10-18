// SPDX-License-Identifier: LGPL-3.0-only
import type { SearchCall } from "@otk/protocol";
import type { ToolRegistry } from "../../registries/renderers.ts";
import { relativeTarget } from "./paths.ts";
import { SearchIcon } from "../ChromeIcons.tsx";
import ToolOutput from "./ToolOutput.tsx";
import { countLabel } from "./count.ts";
export function registerSearchTool(tools: ToolRegistry): void {
  tools.registerTyped(
    "search",
    (props) => <SearchTool call={props.call} directory={props.directory} />,
    (call, context) => ({
      icon: SearchIcon,
      verb: call.mode === "list" ? "List" : "Search",
      target: call.path
        ? relativeTarget(call.path, context.directory)
        : undefined,
      summary: [
        call.mode !== "list" ? call.pattern : "",
        call.mode === "list"
          ? countLabel(call.matches, "entry", "entries")
          : countLabel(call.matches, "match", "matches"),
      ].filter(Boolean).join(" · "),
    }),
  );
}
export default function SearchTool(
  props: { call: SearchCall; directory?: string },
) {
  return (
    <div data-search-mode={props.call.mode}>
      <ToolOutput
        text={props.call.output ?? ""}
        result={props.call.outputContent}
        directory={props.directory}
        limit={10}
      />
    </div>
  );
}
