// SPDX-License-Identifier: LGPL-3.0-only
import { basename, resolve, toFileUrl } from "@std/path";
import type { PromptPart } from "../../../protocol/rpc.ts";
export async function mapPromptParts(parts: PromptPart[], directory: string) {
  return await Promise.all(parts.map(async (part) => {
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
    const path = resolve(directory, part.path), url = toFileUrl(path);
    const isDirectory = (await Deno.stat(path)).isDirectory;
    if (part.range && !isDirectory) {
      url.searchParams.set("start", String(part.range.start));
      url.searchParams.set("end", String(part.range.end));
    }
    return {
      type: "file",
      filename: basename(part.path),
      mime: isDirectory ? "application/x-directory" : "text/plain",
      url: url.href,
    };
  }));
}
