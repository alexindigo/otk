// SPDX-License-Identifier: LGPL-3.0-only
import "./FileDialogParts.css" with { type: "text" };
import { type Element, For, Show } from "solid-js";
import type { FileTarget } from "../features/file-paths.tsx";
import { useCommandPorts } from "../keyboard/context.tsx";
import ActionButton from "./ActionButton.tsx";

export function FileDialogFacts(
  props: { path: string; facts?: string },
): Element {
  return (
    <div class="otk-file-preview-facts">
      <div class="otk-file-preview-path">{props.path}</div>
      <Show when={props.facts}>
        <div>{props.facts}</div>
      </Show>
    </div>
  );
}

export function FileDialogActions(
  props: { target: FileTarget; name: string },
): Element {
  const { commands } = useCommandPorts();
  return (
    <div class="otk-file-preview-actions">
      <For
        each={commands.contextActions(
          { kind: "file", data: props.target },
          true,
        ).filter((action) => action.id !== "file.open")}
      >
        {(action) => (
          <ActionButton
            action={commands.control(action.id, action.args, {
              target: {
                sessionID: props.target.sessionID,
                sidecarId: props.target.sidecarId,
                label: props.name,
              },
              shown: () => true,
              unshown: "The file action did not complete.",
              recovery: "Try again from the file preview.",
            })}
          >
            {action.title}
          </ActionButton>
        )}
      </For>
    </div>
  );
}
