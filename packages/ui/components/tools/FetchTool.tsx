// SPDX-License-Identifier: LGPL-3.0-only
import type { FetchCall } from "@otk/protocol";
import type { ToolRegistry } from "../../registries/renderers.ts";
export function registerFetchTool(tools: ToolRegistry): void {
  tools.registerTyped(
    "fetch",
    (props) => <FetchTool call={props.call} />,
  );
}
export default function FetchTool(props: { call: FetchCall }) {
  return <div class="otk-tool-summary">WebFetch {props.call.url}</div>;
}
