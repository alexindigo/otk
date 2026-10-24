// SPDX-License-Identifier: LGPL-3.0-only
import type { EditCall } from "@otk/protocol";
import type { Preferences } from "@otk/protocol";
import FileChanges from "./FileChanges.tsx";
import { changeCounts } from "./file-changes.ts";
import Diagnostics from "./Diagnostics.tsx";
import type { ToolRegistry } from "../../registries/renderers.ts";
import { relativeTarget } from "./paths.ts";
import { EditIcon } from "./ToolIcons.tsx";
export function registerEditTool(tools: ToolRegistry): void {
  tools.registerTyped(
    "edit",
    (props) => (
      <EditTool
        call={props.call}
        prefs={props.prefs}
        paneWidth={props.paneWidth}
        directory={props.directory}
      />
    ),
    (call, context) => ({
      icon: EditIcon,
      verb: "Edit",
      target: relativeTarget(call.path, context.directory),
      copy: { path: call.path },
      changes: changeCounts(call.files),
      expanded: context.prefs?.collapseFileChanges === false,
    }),
  );
}
export default function EditTool(
  props: {
    call: EditCall;
    prefs: Preferences;
    paneWidth: number;
    directory?: string;
  },
) {
  return (
    <FileChanges
      files={props.call.files}
      prefs={props.prefs}
      paneWidth={props.paneWidth}
      directory={props.directory}
      inline={(file) =>
        props.call.files.length === 1 && file.path === props.call.path}
    >
      <Diagnostics items={props.call.diagnostics} />
    </FileChanges>
  );
}
