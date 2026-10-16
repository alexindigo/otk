// SPDX-License-Identifier: LGPL-3.0-only
import { For } from "solid-js";
import type { EditCall } from "@otk/protocol";
import type { Preferences } from "@otk/protocol";
import Diff from "../Diff.tsx";
import Diagnostics from "./Diagnostics.tsx";
import type { ToolRegistry } from "../../registries/renderers.ts";
export function registerEditTool(tools: ToolRegistry): void {
  tools.registerTyped(
    "edit",
    (props) => (
      <EditTool
        call={props.call}
        prefs={props.prefs}
        paneWidth={props.paneWidth}
      />
    ),
    (call) => ({
      icon: "±",
      verb: "Edit",
      target: call.path,
      summary: call.files.map((file) =>
        `+${file.additions} / −${file.deletions}`
      ).join(", "),
      expanded: true,
    }),
  );
}
export default function EditTool(
  props: { call: EditCall; prefs: Preferences; paneWidth: number },
) {
  return (
    <>
      <div class="otk-tool-summary">
        Edit <span class="otk-path">{props.call.path}</span>
      </div>
      <For each={props.call.files} keyed={false}>
        {(file) => (
          <Diff
            file={file()}
            style={props.prefs.diffStyle}
            wrap={props.prefs.diffWrap}
            paneWidth={props.paneWidth}
          />
        )}
      </For>
      <Diagnostics items={props.call.diagnostics} />
    </>
  );
}
