// SPDX-License-Identifier: LGPL-3.0-only
import type { SkillCall } from "../../../../protocol/content.ts";
export default function SkillTool(props: { call: SkillCall }) {
  return <div class="otk-tool-summary">Skill "{props.call.name}"</div>;
}
