// SPDX-License-Identifier: LGPL-3.0-only
import { fromFileUrl, relative, resolve, toFileUrl } from "@std/path";
import {
  type AttachmentPolicy,
  MAX_UPLOAD_BYTES,
  type OperationContext,
  OperationFailure,
  type PromptPart,
  uploadSize,
} from "@otk/protocol";
import { HarnessError, type PromptCapability } from "@otk/harness";
import type { Client } from "./client.ts";
import type { Directory } from "./directory.ts";
import type { RawPromptPart } from "./types.ts";
import { opencodeV1SessionID as ids } from "./ids.ts";
import { attachmentMime } from "./attachment-mime.ts";
export function prompt(
  client: Client,
  directory: Directory,
  cancel: (id: string) => void,
  policy?: AttachmentPolicy,
): PromptCapability {
  return {
    async prompt(input, operation) {
      const dir = await directory.resolve(input.sessionID);
      await client.request(
        `/session/${
          encodeURIComponent(ids.decode(input.sessionID))
        }/prompt_async`,
        {
          method: "POST",
          ...(operation
            ? { classification: "effect" as const, operation }
            : {}),
          query: { directory: dir },
          body: {
            parts: await mapPromptParts(input.parts, dir, operation, policy),
            variant: input.variant,
            agent: input.agent,
            model: input.model
              ? { providerID: input.model.provider, modelID: input.model.model }
              : undefined,
          },
        },
      );
    },
    async abort(id, operation) {
      await client.json(
        `/session/${encodeURIComponent(ids.decode(id))}/abort`,
        {
          method: "POST",
          ...(operation
            ? { classification: "effect" as const, operation }
            : {}),
          query: { directory: directory.cached(id) },
        },
      );
      cancel(id);
    },
  };
}
export async function mapPromptParts(
  parts: PromptPart[],
  directory: string,
  operation?: OperationContext,
  policy?: AttachmentPolicy,
): Promise<RawPromptPart[]> {
  try {
    const attachments = parts.filter((part) => part.kind === "file");
    if (policy && attachments.length > policy.maxrefs) {
      throw new HarnessError(
        "attachment",
        "Too many attachments in this prompt",
      );
    }
    let bytes = 0;
    for (const part of attachments) {
      if (part.source !== "upload") continue;
      const size = uploadSize(part.dataBase64);
      if (
        size > MAX_UPLOAD_BYTES || (policy && (bytes += size) > policy.maxbytes)
      ) {
        throw new HarnessError(
          "attachment",
          "Attachments exceed the upload byte limit",
        );
      }
    }
    const result: RawPromptPart[] = new Array(parts.length);
    const map = async (part: PromptPart): Promise<RawPromptPart> => {
      operation?.signal.throwIfAborted();
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
      let reference = part.path;
      if (reference.startsWith("file://")) {
        const url = new URL(reference);
        if (url.hostname && url.hostname !== "localhost") {
          throw new HarnessError(
            "attachment",
            "Remote file addresses are not supported. Choose a local file.",
          );
        }
        url.hostname = "";
        reference = fromFileUrl(url);
      }
      const path = resolve(directory, reference), url = toFileUrl(path);
      const { info, mime } = await requiredAttachment(path, part.path);
      const isDirectory = info.isDirectory;
      if (part.range && (isDirectory || mime !== "text/plain")) {
        throw new HarnessError(
          "attachment",
          "Line ranges require a text file. Remove the range before sending.",
        );
      }
      if (part.range) {
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
        mime,
        url: url.href,
      };
    };
    // A shared per-send workset bounds stat/open/readDir across every selected path.
    let next = 0;
    const worker = async () => {
      while (next < parts.length) {
        const index = next++;
        result[index] = await map(parts[index]);
      }
    };
    const settled = await Promise.allSettled(
      Array.from(
        { length: Math.min(parts.length, policy?.concurrency ?? 1) },
        worker,
      ),
    );
    const failed = settled.find((value) => value.status === "rejected");
    if (failed?.status === "rejected") throw failed.reason;
    return result;
  } catch (cause: unknown) {
    // This owner knows preparation completed no native I/O. A conservative core
    // fence must not turn a proven input rejection into an uncertain effect.
    if (operation && cause instanceof HarnessError) {
      throw new OperationFailure("rejected", cause.code, cause);
    }
    throw cause;
  }
}

/** Submission requires readable paths; discovery's no-match policy cannot apply. */
async function requiredAttachment(
  path: string,
  label: string,
): Promise<{ info: Deno.FileInfo; mime: string }> {
  try {
    const info = await Deno.stat(path);
    if (info.isDirectory) {
      // Check listing access without collecting the directory's contents.
      for await (const _entry of Deno.readDir(path)) break;
      return { info, mime: "application/x-directory" };
    }
    using file = await Deno.open(path, { read: true });
    const header = new Uint8Array(8192);
    let length = 0;
    while (length < header.length) {
      const read = await file.read(header.subarray(length));
      if (read === null) break;
      length += read;
    }
    return {
      info,
      mime: attachmentMime(header.subarray(0, length), info.size <= length),
    };
  } catch (cause) {
    const failure = new HarnessError(
      "attachment",
      `Cannot read attachment ${
        JSON.stringify(label)
      }. Restore access or remove it before sending.`,
    );
    failure.cause = cause;
    throw failure;
  }
}
