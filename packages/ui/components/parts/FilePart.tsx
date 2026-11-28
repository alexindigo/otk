// SPDX-License-Identifier: LGPL-3.0-only
import "./FilePart.css" with { type: "text" };
import { Show } from "solid-js";
import type { PartRegistry } from "../../registries/renderers.ts";
import type { DialogRegistry } from "../../registries/shell.ts";
import { ownedAction, useCommandPorts } from "../../keyboard/context.tsx";
import ImageView from "../ImageView.tsx";
import { FileDialogActions, FileDialogFacts } from "../FileDialogParts.tsx";
import type { FileTarget } from "../../features/file-paths.tsx";
import { useContentIdentity } from "../../features/transcript-context.tsx";
export function registerImageDialog(dialogs: DialogRegistry): void {
  dialogs.register<
    {
      name: string;
      url: string;
      path?: string;
      facts?: string;
      target?: FileTarget;
    }
  >({
    id: "image",
    title: (input) => input.name,
    component: (props) => (
      <>
        <Show when={props.input.path}>
          {(path) => (
            <FileDialogFacts path={path()} facts={props.input.facts} />
          )}
        </Show>
        <ImageView
          src={props.input.url}
          name={props.input.name}
          credentialed={!!props.input.target?.image}
        />
      </>
    ),
    actions: (props) => (
      <Show when={props.input.target}>
        {(target) => (
          <FileDialogActions target={target()} name={props.input.name} />
        )}
      </Show>
    ),
  });
}
export function registerFilePart(parts: PartRegistry): void {
  parts.registerTyped(
    "file",
    (props) => {
      const { commands } = useCommandPorts();
      const identity = useContentIdentity();
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
            id={`otk-file-image-${
              encodeURIComponent(JSON.stringify([
                identity.sidecarId,
                identity.sessionID,
                identity.messageID,
                props.part.id,
              ]))
            }`}
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
