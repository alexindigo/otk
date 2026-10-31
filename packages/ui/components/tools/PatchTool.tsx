// SPDX-License-Identifier: LGPL-3.0-only
import type { PatchCall } from "@otk/protocol";
import type { Preferences } from "@otk/protocol";
import FileChanges from "./FileChanges.tsx";
import { changeCounts } from "./file-changes.ts";
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
        directory={props.directory}
      />
    ),
    (call, context) => ({
      icon: EditIcon,
      verb: "Patch",
      copy: call.files.length === 1 ? { path: call.files[0].path } : {
        paths: call.files.flatMap((file) => file.path ? [file.path] : []).join(
          "\n",
        ) || undefined,
      },
      target: call.files.map((file) =>
        file.path
          ? relativeTarget(file.path, context.directory, context.paths)
          : "Path not reported"
      ).join(", "),
      changes: changeCounts(call.files),
      expanded: context.prefs?.collapseFileChanges === false,
    }),
  );
}
export default function PatchTool(
  props: {
    call: PatchCall;
    prefs: Preferences;
    paneWidth?: number;
    directory?: string;
  },
) {
  return (
    <FileChanges
      files={props.call.files}
      prefs={props.prefs}
      directory={props.directory}
      inline={() => props.call.files.length === 1}
    />
  );
}
