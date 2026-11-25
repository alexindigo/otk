// SPDX-License-Identifier: LGPL-3.0-only
import { nativeModel, nativeVariant } from "./selection.ts";
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
import { type Client, HttpFailure, NativeRequestFailure } from "./client.ts";
import { Messages } from "./messages.ts";
import type { Directory } from "./directory.ts";
import type { RawPromptPart } from "./types.ts";
import { opencodeV1SessionID as ids } from "./ids.ts";
import { attachmentMime } from "./attachment-mime.ts";
import { submissionID } from "./submission-id.ts";
export function prompt(
  client: Client,
  directory: Directory,
  cancel: (id: string) => void,
  policy?: AttachmentPolicy,
  submitted?: (
    sessionID: string,
    messageID: string,
    origin?: import("@otk/protocol").RequestOrigin,
  ) => void,
  reader = new Messages(client, directory.cached),
  dispatched: (sessionID: string, messageID: string) => boolean = () => false,
): PromptCapability {
  const pending = new Map<string, Promise<Response>>();
  const abort: PromptCapability["abort"] = async (id, operation) => {
    await client.json(`/session/${encodeURIComponent(ids.decode(id))}/abort`, {
      method: "POST",
      ...(operation ? { classification: "effect" as const, operation } : {}),
      query: { directory: directory.cached(id) },
    });
    cancel(id);
  };
  return {
    async prompt(input, operation) {
      const dir = await directory.resolve(input.sessionID);
      const parts = await mapPromptParts(input.parts, dir, operation, policy);
      const origin = operation?.key.origin;
      const messageID = input.messageID ?? submissionID();
      submitted?.(input.sessionID, messageID, origin);
      const key = `${input.sessionID}/${messageID}`;
      const request = client.request(
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
            messageID,
            parts,
            variant: nativeVariant(input.variant),
            agent: input.agent,
            model: input.model ? nativeModel(input.model) : undefined,
          },
        },
      );
      pending.set(key, request);
      try {
        await request;
      } finally {
        if (pending.get(key) === request) pending.delete(key);
      }
      return { messageID, state: "accepted" };
    },
    abort,
    async withdraw(id, messageID, operation) {
      const request = pending.get(`${id}/${messageID}`);
      try {
        await request;
      } catch (error) {
        if (error instanceof OperationFailure && error.outcome === "rejected") {
          return { state: "absent" };
        }
      }
      const native = ids.decode(id),
        dir = await directory.resolve(id, operation?.signal);
      const signal = AbortSignal.any([
        AbortSignal.timeout(10_000),
        ...(operation ? [operation.signal] : []),
      ]);
      let rounds = 0;
      try {
        while (rounds < 3) {
          await abort(id, operation);
          const status = await client.json<Record<string, { type: string }>>(
            "/session/status",
            {
              query: { directory: dir },
              signal,
            },
          );
          if (status[native] && status[native].type !== "idle") {
            rounds++;
            continue;
          }
          const replies = new Set<string>();
          const users = new Set<string>();
          for await (const { info } of reader.scan(id, dir, signal)) {
            if (
              info.role === "assistant" && info.parentID &&
              info.parentID >= messageID
            ) replies.add(info.parentID);
            if (info.role === "user" && info.id >= messageID) {
              users.add(info.id);
            }
          }
          if (
            users.has(messageID) &&
            [...replies].some((parent) => users.has(parent))
          ) return { state: "started" };
          if (!users.has(messageID)) {
            if (!request && !dispatched(id, messageID)) {
              return { state: "absent" };
            }
            // HTTP 204 acknowledges the async handler, not the message write.
            await new Promise<void>((resolve) => setTimeout(resolve, 100));
            signal.throwIfAborted();
            continue;
          }
          try {
            await client.json(
              `/session/${encodeURIComponent(native)}/message/${
                encodeURIComponent(messageID)
              }`,
              {
                method: "DELETE",
                query: { directory: dir },
                ...(operation
                  ? { classification: "effect" as const, operation }
                  : {}),
              },
            );
            return { state: "withdrawn" };
          } catch (e) {
            const cause = e instanceof NativeRequestFailure ? e.original : e;
            if (
              !(cause instanceof HttpFailure) ||
              cause.detail.kind !== "SessionBusyError"
            ) throw e;
            rounds++;
          }
        }
      } catch (e) {
        if (operation?.signal.aborted || !signal.aborted) throw e;
      }
      return { state: "unconfirmed" };
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
      if (size > MAX_UPLOAD_BYTES) {
        throw new HarnessError(
          "attachment.upload-size",
          "Upload exceeds the per-file byte limit",
        );
      }
      if (
        policy && (bytes += size) > policy.maxbytes
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
