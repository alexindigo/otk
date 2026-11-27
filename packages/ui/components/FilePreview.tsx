// SPDX-License-Identifier: LGPL-3.0-only
import type { Element } from "solid-js";
import { formatBytes, metaList, type PathMention } from "@otk/client";
import { type FilePreview, MAX_PREVIEW_TEXT_BYTES } from "@otk/protocol";
import type { FileTarget } from "../features/file-paths.tsx";
import type { DialogRegistry } from "../registries/shell.ts";
import { ContentIdentityProvider } from "../features/transcript-context.tsx";
import CodeBlock from "./CodeBlock.tsx";
import { FileDialogActions, FileDialogFacts } from "./FileDialogParts.tsx";

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
      <FileDialogFacts
        path={preview().resolved}
        facts={metaList([
          "Text",
          preview().truncated
            ? `first ${formatBytes(MAX_PREVIEW_TEXT_BYTES)} of ${
              formatBytes(preview().size)
            }`
            : formatBytes(preview().size),
          marked(),
        ])}
      />
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

export function registerFilePreviewDialog(dialogs: DialogRegistry): void {
  dialogs.register<Input>({
    id: "file-preview",
    size: "standard",
    title: (input) => input.preview.name,
    component: (props) => <FilePreviewView input={props.input} />,
    actions: (props) => (
      <FileDialogActions
        target={props.input.target}
        name={props.input.preview.name}
      />
    ),
  });
}
