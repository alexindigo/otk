// SPDX-License-Identifier: LGPL-3.0-only
import { fromFileUrl, relative, resolve, toFileUrl } from "@std/path";
import { decodeBase64, encodeBase64 } from "@std/encoding/base64";
import { HarnessError } from "@otk/harness";
import {
  type AttachmentPolicy,
  MAX_UPLOAD_BYTES,
  type OperationContext,
  OperationFailure,
  type PromptCapability,
  type PromptInput,
  type PromptPart,
  uploadSize,
} from "@otk/protocol";
import type { OpenCodeClient, V2Client } from "./client.ts";
import { opencodeV2SessionID as ids } from "./ids.ts";
import { interrupt } from "./interrupt.ts";
import { selectionModel } from "./selection.ts";
type NativeInput = Parameters<OpenCodeClient["session"]["prompt"]>[0];
type Prepared = Pick<NativeInput, "text" | "files" | "agents">;

/** All input validation/preparation precedes every native selection effect. */
export async function preparePrompt(
  parts: readonly PromptPart[],
  directory: string,
  policy?: AttachmentPolicy,
  signal?: AbortSignal,
): Promise<Prepared> {
  try {
    const text = parts.flatMap((p) => p.kind === "text" ? [p.text] : []).join(
      "",
    );
    const files = parts.filter((p) => p.kind === "file");
    if (policy && files.length > policy.maxrefs) {
      throw new HarnessError(
        "attachment",
        "Too many attachments in this prompt",
      );
    }
    let bytes = 0;
    for (const part of files) {
      if (part.source === "upload") {
        const size = uploadSize(part.dataBase64);
        if (size > MAX_UPLOAD_BYTES) {
          throw new HarnessError(
            "attachment.upload-size",
            "Upload exceeds the per-file byte limit",
          );
        }
        bytes += size;
        if (policy && bytes > policy.maxbytes) {
          throw new HarnessError(
            "attachment",
            "Attachments exceed the upload byte limit",
          );
        }
      }
    }
    const mention = (part: PromptPart) => {
      const value = part.mention;
      if (
        value &&
        (!Number.isSafeInteger(value.start) ||
          !Number.isSafeInteger(value.end) || value.start < 0 ||
          value.end < value.start ||
          text.slice(value.start, value.end) !== value.text)
      ) {
        throw new HarnessError(
          "attachment",
          "A mention no longer matches the prompt text. Select it again before sending.",
        );
      }
      return value ? { mention: { ...value } } : {};
    };
    const output: NonNullable<Prepared["files"]>[number][] = new Array(
      files.length,
    );
    const map = async (
      part: typeof files[number],
    ): Promise<NonNullable<Prepared["files"]>[number]> => {
      signal?.throwIfAborted();
      if (part.source === "resource") {
        throw new HarnessError(
          "attachment",
          "This opencode service cannot attach MCP resources. Remove the resource before sending.",
        );
      }
      if (part.source === "history") {
        throw new HarnessError(
          "attachment",
          "Resolve the recalled attachment before sending",
        );
      }
      if (part.source === "upload") {
        if (
          !/^[\w.+-]+\/[\w.+-]+$/.test(part.mime) ||
          encodeBase64(decodeBase64(part.dataBase64)) !== part.dataBase64
        ) {
          throw new HarnessError(
            "attachment",
            "Invalid upload bytes or MIME type",
          );
        }
        return {
          uri: `data:${part.mime};base64,${part.dataBase64}`,
          name: part.name,
          source: { type: "inline" },
          ...mention(part),
        };
      }
      let reference = part.path;
      if (reference.startsWith("file:")) {
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
      const path = resolve(directory, reference), uri = toFileUrl(path);
      try {
        const info = await Deno.stat(path);
        if (info.isDirectory) {
          if (part.range) {
            throw new HarnessError(
              "attachment",
              "Line ranges require a text file",
            );
          }
          let size = 0;
          for await (const entry of Deno.readDir(path)) {
            signal?.throwIfAborted();
            size += new TextEncoder().encode(entry.name).length + 2;
            if (size > MAX_UPLOAD_BYTES) {
              throw new HarnessError(
                "attachment",
                "Directory attachment exceeds the per-file byte limit",
              );
            }
          }
        } else {
          if (!info.isFile || info.size > MAX_UPLOAD_BYTES) {
            throw new HarnessError(
              "attachment",
              "Attachment is not a file or exceeds the per-file byte limit",
            );
          }
          // Read every selected byte before switches. Native still owns file URI
          // materialization and checks again at dispatch, including concurrent edits.
          const content = await Deno.readFile(path);
          signal?.throwIfAborted();
          if (content.length > MAX_UPLOAD_BYTES) {
            throw new HarnessError(
              "attachment",
              "Attachment exceeds the per-file byte limit",
            );
          }
          if (part.range) {
            if (
              !Number.isSafeInteger(part.range.start) || part.range.start < 1 ||
              part.range.end !== undefined &&
                (!Number.isSafeInteger(part.range.end) ||
                  part.range.end < part.range.start)
            ) throw new HarnessError("attachment", "Invalid file line range");
            try {
              if (content.includes(0)) throw new Error("binary");
              new TextDecoder("utf-8", { fatal: true }).decode(content);
            } catch {
              throw new HarnessError(
                "attachment",
                "Line ranges require a text file",
              );
            }
            uri.searchParams.set("start", String(part.range.start));
            if (part.range.end !== undefined) {
              uri.searchParams.set("end", String(part.range.end));
            }
          }
        }
      } catch (cause) {
        if (cause instanceof HarnessError) throw cause;
        signal?.throwIfAborted();
        throw new HarnessError(
          "attachment",
          `Cannot read attachment ${
            JSON.stringify(part.path)
          }. Restore access or remove it before sending.`,
        );
      }
      return {
        uri: uri.href,
        name: relative(directory, path) +
          (part.range
            ? `#${part.range.start}${
              part.range.end === undefined ? "" : `-${part.range.end}`
            }`
            : ""),
        ...mention(part),
      };
    };
    let next = 0;
    const worker = async () => {
      while (next < files.length) {
        const index = next++;
        output[index] = await map(files[index]);
      }
    };
    const results = await Promise.allSettled(
      Array.from(
        { length: Math.min(files.length, policy?.concurrency ?? 1) },
        worker,
      ),
    );
    const failed = results.find((r) => r.status === "rejected");
    if (failed?.status === "rejected") throw failed.reason;
    const agents = parts.flatMap((part) =>
      part.kind === "agent" ? [{ name: part.name, ...mention(part) }] : []
    );
    signal?.throwIfAborted();
    return {
      text,
      ...(output.length ? { files: output } : {}),
      ...(agents.length ? { agents } : {}),
    };
  } catch (cause) {
    signal?.throwIfAborted();
    if (cause instanceof OperationFailure) throw cause;
    // This owner has performed no native mutation, including when a URI/base64
    // parser rejects before the filesystem read. The unsent draft is retryable.
    throw new OperationFailure(
      "rejected",
      cause instanceof HarnessError ? cause.code : "attachment",
      cause,
    );
  }
}
/** Direct callers and core callers share one same-session selection/prompt sequence. */
export class V2Prompt implements PromptCapability {
  #tails = new Map<string, Promise<void>>();
  constructor(
    readonly client: () => V2Client,
    readonly policy?: AttachmentPolicy,
    readonly interruptSession?: (
      id: string,
      operation?: OperationContext,
    ) => Promise<void>,
  ) {}
  async prompt(
    input: PromptInput,
    operation?: OperationContext,
  ): Promise<void> {
    const native = ids.decode(input.sessionID),
      client = this.client();
    const work = client.sequence(native, async () => {
      client.signal.throwIfAborted();
      operation?.signal.throwIfAborted();
      const session = await client.read(
        (api) => api.session.get({ sessionID: native }),
        operation?.signal,
      );
      const prepared = await preparePrompt(
        input.parts,
        session.location.directory,
        this.policy,
        operation?.signal,
      );
      const model = await selectionModel(client, session, input, operation);
      if (input.agent !== undefined && input.agent !== session.agent) {
        await client.effect(
          (api) =>
            api.session.switchAgent({ sessionID: native, agent: input.agent! }),
          operation,
        );
        await operation?.checkpoint("prompt-selection", {
          kind: "prompt-selection",
          value: { sessionID: input.sessionID, agent: input.agent },
        });
      }
      if (
        model &&
        (model.providerID !== session.model?.providerID ||
          model.id !== session.model?.id ||
          (model.variant ?? "default") !==
            (session.model?.variant ?? "default"))
      ) {
        await client.effect(
          (api) => api.session.switchModel({ sessionID: native, model }),
          operation,
        );
        await operation?.checkpoint("prompt-selection", {
          kind: "prompt-selection",
          value: {
            sessionID: input.sessionID,
            model: { provider: model.providerID, model: model.id },
            ...(model.variant === undefined ? {} : { variant: model.variant }),
            ...(input.agent === undefined ? {} : { agent: input.agent }),
          },
        });
      }
      await client.effect(
        (api) => api.session.prompt({ sessionID: native, ...prepared }),
        operation,
      );
    }, operation);
    const tail = work.then(() => {}, () => {});
    this.#tails.set(native, tail);
    try {
      await work;
    } finally {
      if (this.#tails.get(native) === tail) this.#tails.delete(native);
    }
  }
  abort(id: string, operation?: OperationContext): Promise<void> {
    if (this.interruptSession) return this.interruptSession(id, operation);
    return interrupt(this.client(), id, operation);
  }
  async stop(): Promise<void> {
    await Promise.allSettled([...this.#tails.values()]);
  }
}
