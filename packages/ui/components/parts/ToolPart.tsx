// SPDX-License-Identifier: LGPL-3.0-only
import { Show } from "solid-js";
import type { Part } from "@otk/protocol";
type ToolPart = Extract<Part, { kind: "tool" }>;
import type { PartRegistry } from "../../registries/renderers.ts";
import ToolLine from "../ToolLine.tsx";
export function registerToolPart(parts: PartRegistry): void {
  parts.register("tool", (props) => {
    const call = () => (props.part as ToolPart).call;
    return (
      <Show when={props.prefs.toolDetails || call().status !== "completed"}>
        <ToolLine
          call={call()}
          prefs={props.prefs}
          paneWidth={props.paneWidth}
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
  });
}
