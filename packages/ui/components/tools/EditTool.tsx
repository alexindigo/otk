// SPDX-License-Identifier: LGPL-3.0-only
import { For } from "solid-js";
import type { EditCall } from "@otk/protocol";
import type { Preferences } from "@otk/protocol";
import Diff from "../Diff.tsx";
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
      changes: {
        additions: call.files.reduce((n, file) => n + file.additions, 0),
        deletions: call.files.reduce((n, file) => n + file.deletions, 0),
      },
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
    <>
      <For each={props.call.files} keyed={false}>
        {(file) => (
          <Diff
            file={file()}
            inline={props.call.files.length === 1 &&
              file().path === props.call.path}
            style={props.prefs.diffStyle}
            wrap={props.prefs.diffWrap}
            paneWidth={props.paneWidth}
            directory={props.directory}
          />
        )}
      </For>
      <Diagnostics items={props.call.diagnostics} />
    </>
  );
}
