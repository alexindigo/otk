// SPDX-License-Identifier: LGPL-3.0-only
import "./FilePart.css" with { type: "text" };
import { Show } from "solid-js";
import type { PartRegistry } from "../../registries/renderers.ts";
import type { DialogRegistry } from "../../registries/shell.ts";
import { ownedAction, useCommandPorts } from "../../keyboard/context.tsx";
import ImageView from "../ImageView.tsx";
export function registerImageDialog(dialogs: DialogRegistry): void {
  dialogs.register<{ name: string; url: string }>({
    id: "image",
    title: (input) => input.name,
    component: (props) => (
      <ImageView src={props.input.url} name={props.input.name} />
    ),
  });
}
export function registerFilePart(parts: PartRegistry): void {
  parts.registerTyped(
    "file",
    (props) => {
      const { commands } = useCommandPorts();
      const open = ownedAction("image.open", () =>
        commands.run("dialog.open", {
          id: "image",
          input: { name: props.part.name, url: props.part.url },
        }));
      return (
        <Show
          when={props.part.mime.startsWith("image/") && props.part.url}
          fallback={
            <span class="otk-chip" title={props.part.path}>
              {props.part.mime === "application/x-directory"
                ? "Directory"
                : "File"}: <span class="otk-path">{props.part.name}</span>
            </span>
          }
        >
          <button
            type="button"
            class="otk-file-image"
            aria-label={`Open image: ${props.part.name}`}
            title={props.part.name}
            onClick={() => void open()}
          >
            <img src={props.part.url} alt={props.part.name} />
          </button>
        </Show>
      );
    },
  );
}
