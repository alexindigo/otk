// SPDX-License-Identifier: LGPL-3.0-only
import type { WriteCall } from "@otk/protocol";
import CodeBlock from "../CodeBlock.tsx";
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
      target: relativeTarget(call.path, context.directory, context.paths),
      copy: { path: call.path },
      category: "fileChanges",
    }),
  );
}
export default function WriteTool(props: { call: WriteCall }) {
  return (
    <>
      <CodeBlock
        source={{
          kind: "file",
          text: props.call.content,
          lang: props.call.lang,
          startLine: 1,
        }}
      />
      <Diagnostics items={props.call.diagnostics} />
    </>
  );
}
