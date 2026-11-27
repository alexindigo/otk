// SPDX-License-Identifier: LGPL-3.0-only
import {
  type CommandHub,
  type FileFacts,
  folderCommand,
  imageReason,
  type PathMention,
  RequestFailure,
  type SidecarConnection,
  terminalBoxFor,
} from "@otk/client";
import { type FileFactFound, OperationFailure, randomID } from "@otk/protocol";
import { copyText } from "../clipboard.ts";
import { solidState } from "../state/binding.ts";

export interface FileTarget {
  sidecarId: string;
  sessionID: string;
  mention: PathMention;
  fact: FileFactFound;
  image?: { url: string; facts: string; name: string };
}

export function registerFileCommands(
  commands: CommandHub,
  connection: (id: string) => SidecarConnection,
  facts: (id: string) => FileFacts,
): () => void {
  const box = (target: FileTarget) =>
    terminalBoxFor(connection(target.sidecarId), target.sessionID, solidState);
  const open = commands.register({
    id: "file.open",
    title: "Open preview",
    category: "Transcript",
    arguments: { type: "object" },
    context: { kind: "file", order: 10 },
    availability: (_context, target?: FileTarget) =>
      target?.fact && target.fact.preview !== "none" ? { available: true } : {
        available: false,
        hidden: true,
        reason: "This file cannot be previewed",
      },
    async run(_context, target: FileTarget) {
      if (target.image) {
        await commands.run("dialog.open", {
          id: "image",
          input: { ...target.image, path: target.fact.resolved, target },
        });
        return;
      }
      const { sidecarId, sessionID, mention } = target;
      const invalidate = () =>
        facts(sidecarId).invalidate(sessionID, mention.path);
      const preview = await connection(sidecarId).rpc.call("file.preview", {
        sessionID,
        path: mention.path,
      }).catch((cause: unknown) => {
        if (
          cause instanceof RequestFailure &&
          cause.failure.code === "file-unavailable"
        ) invalidate();
        throw cause;
      });
      if (preview.kind === "image") {
        await commands.run("dialog.open", {
          id: "image",
          input: {
            name: preview.name,
            url: `data:${preview.mime};base64,${preview.dataBase64}`,
            path: preview.resolved,
            target,
          },
        });
      } else if (preview.kind === "text") {
        await commands.run("dialog.open", {
          id: "file-preview",
          input: { preview, line: mention.line, target },
        });
      } else if (preview.kind === "unavailable") {
        throw new RequestFailure({
          code: preview.reason,
          diagnosticID: randomID(),
          retry: "none",
          facts: {
            actionLabel: "Open preview",
            reason: imageReason({
              path: mention.path,
              status: "unavailable",
              reason: preview.reason,
            }),
          },
        });
      } else {
        invalidate();
        throw new OperationFailure("rejected", "file-unavailable", undefined, {
          actionLabel: "Open preview",
          reason: "OTK cannot preview this file.",
        });
      }
    },
  });
  const copy = commands.register({
    id: "file.copyPath",
    title: "Copy path",
    category: "Transcript",
    arguments: { type: "object" },
    context: { kind: "file", order: 20 },
    enabled: (_context, target?: FileTarget) => !!target?.fact,
    run: (_context, target: FileTarget) =>
      copyText(target.fact.resolved, {
        actionLabel: "Copy path",
        target: "File path",
        recovery: "Select the path and press Ctrl+C (Cmd+C on macOS).",
      }),
  });
  const folder = commands.register({
    id: "file.openFolder",
    title: "Open folder in terminal",
    category: "Transcript",
    arguments: { type: "object" },
    context: { kind: "file", order: 30 },
    availability: (_context, target?: FileTarget) => {
      if (!target?.fact) {
        return { available: false, hidden: true, reason: "No file selected" };
      }
      const reason = box(target).unavailable;
      return reason ? { available: false, reason } : { available: true };
    },
    run: (_context, target: FileTarget) =>
      box(target).run(folderCommand(target.fact)),
  });
  return () => {
    folder();
    copy();
    open();
  };
}
