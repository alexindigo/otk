// SPDX-License-Identifier: LGPL-3.0-only
import { relative, resolve, toFileUrl } from "@std/path";
import type { PromptPart } from "../../../protocol/rpc.ts";
import { statMatch } from "./files.ts";
import { HarnessError } from "../types.ts";
export async function mapPromptParts(parts: PromptPart[], directory: string) {
  return (await Promise.all(parts.map(async (part) => {
    if (part.kind === "text") return { type: "text", text: part.text };
    if (part.kind === "agent") return { type: "agent", name: part.name };
    if (part.source === "upload") {
      return {
        type: "file",
        filename: part.name,
        mime: part.mime,
        url: `data:${part.mime};base64,${part.dataBase64}`,
      };
    }
    if (part.source === "resource") {
      return {
        type: "file",
        filename: part.name,
        mime: part.mime,
        url: part.uri,
        source: {
          type: "resource",
          clientName: part.server,
          uri: part.uri,
          text: { start: 0, end: part.name.length + 1, value: `@${part.name}` },
        },
      };
    }
    if (part.source === "history") {
      throw new HarnessError(
        "params",
        "Resolve the recalled attachment before sending",
      );
    }
    const path = resolve(directory, part.path), url = toFileUrl(path);
    const info = await statMatch(path);
    if (!info) return undefined;
    const isDirectory = info.isDirectory;
    if (part.range && !isDirectory) {
      url.searchParams.set("start", String(part.range.start));
      if (part.range.end !== undefined) {
        url.searchParams.set("end", String(part.range.end));
      }
    }
    return {
      type: "file",
      filename: relative(directory, path) +
        (part.range
          ? `#${part.range.start}${
            part.range.end === undefined ? "" : `-${part.range.end}`
          }`
          : ""),
      mime: isDirectory ? "application/x-directory" : "text/plain",
      url: url.href,
    };
  }))).filter((part) => part !== undefined);
}
