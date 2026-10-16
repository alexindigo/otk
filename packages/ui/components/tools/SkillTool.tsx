// SPDX-License-Identifier: LGPL-3.0-only
import type { SkillCall } from "@otk/protocol";
import type { ToolRegistry } from "../../registries/renderers.ts";
export function registerSkillTool(tools: ToolRegistry): void {
  tools.registerTyped(
    "skill",
    (props) => <SkillTool call={props.call} />,
    (call) => ({ icon: "◇", verb: "Load skill", target: call.name }),
  );
}
export default function SkillTool(props: { call: SkillCall }) {
  return <div class="otk-tool-summary">Skill "{props.call.name}"</div>;
}
