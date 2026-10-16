// SPDX-License-Identifier: LGPL-3.0-only
import type { WriteCall } from "@otk/protocol";
import Code from "../Code.tsx";
import Diagnostics from "./Diagnostics.tsx";
import type { ToolRegistry } from "../../registries/renderers.ts";
export function registerWriteTool(tools: ToolRegistry): void {
  tools.registerTyped(
    "write",
    (props) => <WriteTool call={props.call} />,
    (call) => ({ icon: "±", verb: "Write", target: call.path, expanded: true }),
  );
}
export default function WriteTool(props: { call: WriteCall }) {
  return (
    <>
      <div class="otk-tool-summary">
        Write <span class="otk-path">{props.call.path}</span>
      </div>
      <Code text={props.call.content} lang={props.call.lang} lineNumbers />
      <Diagnostics items={props.call.diagnostics} />
    </>
  );
}
