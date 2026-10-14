// SPDX-License-Identifier: LGPL-3.0-only
import { relative, resolve, toFileUrl } from "@std/path";
import type { PromptPart } from "@otk/protocol";
import { statMatch } from "./files.ts";
import { HarnessError, type PromptCapability } from "@otk/harness";
import type { Client } from "./client.ts";
import type { Directory } from "./directory.ts";
import type { RawPromptPart } from "./types.ts";
export function prompt(
  client: Client,
  directory: Directory,
  cancel: (id: string) => void,
): PromptCapability {
  return {
    async prompt(input) {
      const dir = await directory.resolve(input.sessionID);
      await client.request(
        `/session/${encodeURIComponent(input.sessionID)}/prompt_async`,
        {
          method: "POST",
          query: { directory: dir },
          body: {
            parts: await mapPromptParts(input.parts, dir),
            variant: input.variant,
            agent: input.agent,
            model: input.model
              ? { providerID: input.model.provider, modelID: input.model.model }
              : undefined,
          },
        },
      );
    },
    async abort(id) {
      await client.json(`/session/${encodeURIComponent(id)}/abort`, {
        method: "POST",
        query: { directory: directory.cached(id) },
      });
      cancel(id);
    },
  };
}
export async function mapPromptParts(
  parts: PromptPart[],
  directory: string,
): Promise<RawPromptPart[]> {
  return (await Promise.all(
    parts.map(async (part): Promise<RawPromptPart | undefined> => {
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
            text: {
              start: 0,
              end: part.name.length + 1,
              value: `@${part.name}`,
            },
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
    }),
  )).filter((part) => part !== undefined);
}
