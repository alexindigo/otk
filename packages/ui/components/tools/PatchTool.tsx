// SPDX-License-Identifier: LGPL-3.0-only
import { For } from "solid-js";
import type { PatchCall } from "@otk/protocol";
import type { Preferences } from "@otk/protocol";
import Diff from "../Diff.tsx";
import type { ToolRegistry } from "../../registries/renderers.ts";
import { relativeTarget } from "./paths.ts";
import { EditIcon } from "./ToolIcons.tsx";
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
    (call, context) => ({
      icon: EditIcon,
      verb: "Patch",
      target: call.files.map((file) =>
        relativeTarget(file.path, context.directory)
      ).join(", "),
      changes: {
        additions: call.files.reduce((n, file) => n + file.additions, 0),
        deletions: call.files.reduce((n, file) => n + file.deletions, 0),
      },
      expanded: true,
    }),
  );
}
export default function PatchTool(
  props: { call: PatchCall; prefs: Preferences; paneWidth: number },
) {
  return (
    <>
      <For each={props.call.files} keyed={false}>
        {(file) => (
          <Diff
            file={file()}
            inline={props.call.files.length === 1}
            style={props.prefs.diffStyle}
            wrap={props.prefs.diffWrap}
            paneWidth={props.paneWidth}
          />
        )}
      </For>
    </>
  );
}
