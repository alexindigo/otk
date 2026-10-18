// SPDX-License-Identifier: LGPL-3.0-only
import type { SkillCall } from "@otk/protocol";
import type { ToolRegistry } from "../../registries/renderers.ts";
import ToolOutput from "./ToolOutput.tsx";
export function registerSkillTool(tools: ToolRegistry): void {
  tools.registerTyped(
    "skill",
    (props) => <SkillTool call={props.call} directory={props.directory} />,
    (call) => ({ icon: "◇", verb: "Load skill", target: call.name }),
  );
}
export default function SkillTool(
  props: { call: SkillCall; directory?: string },
) {
  return (
    <ToolOutput
      text={props.call.output ?? ""}
      result={props.call.outputContent}
      directory={props.directory}
      limit={10}
    />
  );
}
