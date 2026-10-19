// SPDX-License-Identifier: LGPL-3.0-only
import type { WriteCall } from "@otk/protocol";
import Code from "../Code.tsx";
import Diagnostics from "./Diagnostics.tsx";
import type { ToolRegistry } from "../../registries/renderers.ts";
import { relativeTarget } from "./paths.ts";
import { EditIcon } from "./ToolIcons.tsx";
export function registerWriteTool(tools: ToolRegistry): void {
  tools.registerTyped(
    "write",
    (props) => <WriteTool call={props.call} />,
    (call, context) => ({
      icon: EditIcon,
      verb: "Write",
      target: relativeTarget(call.path, context.directory),
      expanded: context.prefs?.collapseFileChanges === false,
    }),
  );
}
export default function WriteTool(props: { call: WriteCall }) {
  return (
    <>
      <Code text={props.call.content} lang={props.call.lang} lineNumbers />
      <Diagnostics items={props.call.diagnostics} />
    </>
  );
}
