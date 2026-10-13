// SPDX-License-Identifier: LGPL-3.0-only
import type { SkillCall } from "@otk/protocol";
export default function SkillTool(props: { call: SkillCall }) {
  return <div class="otk-tool-summary">Skill "{props.call.name}"</div>;
}
