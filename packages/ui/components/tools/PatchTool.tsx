// SPDX-License-Identifier: LGPL-3.0-only
import { For } from "solid-js";
import type { PatchCall } from "@otk/protocol";
import type { Preferences } from "@otk/protocol";
import Diff from "../Diff.tsx";
import type { ToolRegistry } from "../../registries/renderers.ts";
export function registerPatchTool(tools: ToolRegistry): void {
  tools.registerTyped(
    "patch",
    (props) => (
      <PatchTool
        call={props.call}
        prefs={props.prefs}
        paneWidth={props.paneWidth}
      />
    ),
    (call) => ({
      icon: "±",
      verb: "Patch",
      target: call.files.map((file) => file.path).join(", "),
      expanded: true,
    }),
  );
}
export default function PatchTool(
  props: { call: PatchCall; prefs: Preferences; paneWidth: number },
) {
  return (
    <>
      <div class="otk-tool-summary">Patch</div>
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
    </>
  );
}
