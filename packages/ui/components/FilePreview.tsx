// SPDX-License-Identifier: LGPL-3.0-only
import "./FilePreview.css" with { type: "text" };
import { type Element, For } from "solid-js";
import { formatBytes, metaList, type PathMention } from "@otk/client";
import { type FilePreview, MAX_PREVIEW_TEXT_BYTES } from "@otk/protocol";
import type { FileTarget } from "../features/file-paths.tsx";
import { useCommandPorts } from "../keyboard/context.tsx";
import type { DialogRegistry } from "../registries/shell.ts";
import { ContentIdentityProvider } from "../features/transcript-context.tsx";
import ActionButton from "./ActionButton.tsx";
import CodeBlock from "./CodeBlock.tsx";

type Input = {
  preview: Extract<FilePreview, { kind: "text" }>;
  line?: PathMention["line"];
  target: FileTarget;
};

function FilePreviewView(props: { input: Input }): Element {
  const preview = () => props.input.preview;
  const marked = () => {
    const line = props.input.line;
    return line &&
      (line.start === line.end
        ? `line ${line.start} marked`
        : `lines ${line.start}-${line.end} marked`);
  };
  return (
    <ContentIdentityProvider value={props.input.target}>
      <div class="otk-file-preview-facts">
        <div class="otk-file-preview-path">{preview().resolved}</div>
        <div>
          {metaList([
            "Text",
            preview().truncated
              ? `first ${formatBytes(MAX_PREVIEW_TEXT_BYTES)} of ${
                formatBytes(preview().size)
              }`
              : formatBytes(preview().size),
            marked(),
          ])}
        </div>
      </div>
      <CodeBlock
        source={{
          kind: "file",
          text: preview().text,
          lang: preview().lang,
          startLine: 1,
        }}
        mark={props.input.line}
      />
    </ContentIdentityProvider>
  );
}

function FilePreviewActions(props: { input: Input }): Element {
  const { commands } = useCommandPorts();
  return (
    <div class="otk-file-preview-actions">
      <For
        each={commands.contextActions({
          kind: "file",
          data: props.input.target,
        }, true).filter((action) => action.id !== "file.open")}
      >
        {(action) => {
          return (
            <ActionButton
              action={commands.control(action.id, action.args, {
                target: {
                  sessionID: props.input.target.sessionID,
                  sidecarId: props.input.target.sidecarId,
                  label: props.input.preview.name,
                },
                shown: () => true,
                unshown: "The file action did not complete.",
                recovery: "Try again from the file preview.",
              })}
            >
              {action.title}
            </ActionButton>
          );
        }}
      </For>
    </div>
  );
}

export function registerFilePreviewDialog(dialogs: DialogRegistry): void {
  dialogs.register<Input>({
    id: "file-preview",
    size: "standard",
    title: (input) => input.preview.name,
    component: (props) => <FilePreviewView input={props.input} />,
    actions: (props) => <FilePreviewActions input={props.input} />,
  });
}
