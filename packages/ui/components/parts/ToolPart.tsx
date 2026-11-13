// SPDX-License-Identifier: LGPL-3.0-only
import { Show } from "solid-js";
import { permissionTool, toolFailure } from "@otk/client";
import type { PartRegistry } from "../../registries/renderers.ts";
import ToolLine from "../ToolLine.tsx";
export function registerToolPart(parts: PartRegistry): void {
  parts.registerTyped(
    "tool",
    (props) => {
      const call = () => permissionTool(props.part.call, props.permissions);
      return (
        <Show
          when={props.prefs.toolDetails || call().status !== "completed" ||
            !!toolFailure(call())}
        >
          <ToolLine
            call={call()}
            prefs={props.prefs}
            onOpenChild={props.onOpenChild}
            genericOutput={props.prefs.genericToolOutput}
            directory={props.directory}
            waiting={props.permissions.some((request) =>
              request.toolCall === call().callID ||
              request.sessionID === call().childSessionID
            )}
          />
        </Show>
      );
    },
    (part, prefs) => ({
      required: !!toolFailure(part.call),
      work: prefs.toolDetails || part.call.status !== "completed" ||
          !!toolFailure(part.call)
        ? part.call.time
        : undefined,
    }),
  );
}
