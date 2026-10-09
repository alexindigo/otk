// SPDX-License-Identifier: LGPL-3.0-only
import type { WebSearchCall } from "../../../../protocol/content.ts";
export default function WebSearchTool(props: { call: WebSearchCall }) {
  return (
    <div class="otk-tool-summary">
      {props.call.provider ? `${props.call.provider} Web Search` : "Web Search"}
      {" "}
      "{props.call.query}"
    </div>
  );
}
