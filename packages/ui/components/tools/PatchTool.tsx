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
        directory={props.directory}
      />
    ),
    (call, context) => ({
      icon: EditIcon,
      verb: "Patch",
      copy: call.files.length === 1
        ? { path: call.files[0].path }
        : { paths: call.files.map((file) => file.path).join("\n") },
      target: call.files.map((file) =>
        relativeTarget(file.path, context.directory)
      ).join(", "),
      changes: {
        additions: call.files.reduce((n, file) => n + file.additions, 0),
        deletions: call.files.reduce((n, file) => n + file.deletions, 0),
      },
      expanded: context.prefs?.collapseFileChanges === false,
    }),
  );
}
export default function PatchTool(
  props: {
    call: PatchCall;
    prefs: Preferences;
    paneWidth: number;
    directory?: string;
  },
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
            directory={props.directory}
          />
        )}
      </For>
    </>
  );
}
