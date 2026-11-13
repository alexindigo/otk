// SPDX-License-Identifier: LGPL-3.0-only
import { HarnessError } from "@otk/harness";
import {
  type AttachmentPolicy,
  type CommandInput,
  type CommandOption,
  type CommandsCapability,
  MAX_UPLOAD_BYTES,
  type OperationContext,
  OperationFailure,
  uploadSize,
} from "@otk/protocol";
import { fromFileUrl, relative, resolve, toFileUrl } from "@std/path";
import type { OpenCodeClient, V2Client } from "./client.ts";
import { opencodeV2SessionID as ids } from "./ids.ts";
import { selectAction } from "./session-actions.ts";
import { mapCommands, mapSkills, mergeCommands } from "./catalog-readers.ts";
type Files = NonNullable<
  Parameters<OpenCodeClient["session"]["command"]>[0]["files"]
>;

/** Commands prepare every file before switches/dispatch, retaining all-or-fail sends. */
export async function commandFiles(
  input: CommandInput,
  directory: string,
  policy?: AttachmentPolicy,
  operation?: OperationContext,
): Promise<Files> {
  try {
    return await prepareCommandFiles(input, directory, policy, operation);
  } catch (cause) {
    // Preparation has performed no native I/O. The core's conservative fence
    // cannot turn a proven input rejection into an uncertain dispatch.
    if (cause instanceof HarnessError) {
      throw new OperationFailure("rejected", cause.code, cause);
    }
    throw cause;
  }
}
async function prepareCommandFiles(
  input: CommandInput,
  directory: string,
  policy?: AttachmentPolicy,
  operation?: OperationContext,
): Promise<Files> {
  const parts = input.parts ?? [], files: Files[number][] = [];
  if (policy && parts.length > policy.maxrefs) {
    throw new HarnessError(
      "attachment",
      "Too many attachments in this command",
    );
  }
  let bytes = 0;
  for (const part of parts) {
    operation?.signal.throwIfAborted();
    if (part.source === "upload") {
      const size = uploadSize(part.dataBase64);
      if (
        size > MAX_UPLOAD_BYTES || policy && (bytes += size) > policy.maxbytes
      ) {
        throw new HarnessError(
          "attachment",
          "Attachments exceed the upload byte limit",
        );
      }
      files.push({
        uri: `data:${part.mime};base64,${part.dataBase64}`,
        name: part.name,
      });
      continue;
    }
    if (part.source !== "path") {
      throw new HarnessError(
        "attachment",
        part.source === "history"
          ? "Resolve the recalled attachment before sending"
          : "This service cannot attach MCP resources",
      );
    }
    let path: string;
    try {
      let reference = part.path;
      if (reference.startsWith("file://")) {
        const url = new URL(reference);
        if (url.hostname && url.hostname !== "localhost") {
          throw new Error("Remote file address");
        }
        url.hostname = "";
        reference = fromFileUrl(url);
      }
      path = resolve(directory, reference);
      const info = await Deno.stat(path);
      if (info.isDirectory) {
        for await (const _entry of Deno.readDir(path)) break;
        if (part.range) throw new Error("A directory has no line range");
      } else {
        using file = await Deno.open(path, { read: true });
        const header = new Uint8Array(8192),
          size = await file.read(header) ?? 0;
        if (part.range) {
          if (header.subarray(0, size).includes(0)) {
            throw new Error("Line ranges require text");
          }
          new TextDecoder("utf-8", { fatal: true }).decode(
            header.subarray(0, size),
            { stream: info.size > size },
          );
        }
      }
    } catch {
      throw new HarnessError(
        "attachment",
        `Cannot read attachment ${part.path}`,
      );
    }
    const url = toFileUrl(path);
    if (part.range) {
      url.searchParams.set("start", String(part.range.start));
      if (part.range.end !== undefined) {
        url.searchParams.set("end", String(part.range.end));
      }
    }
    files.push({
      uri: url.href,
      name: part.label ?? relative(directory, path),
    });
  }
  return files;
}
export function commands(
  client: () => V2Client,
  policy?: AttachmentPolicy,
  list?: (id: string, signal?: AbortSignal) => Promise<CommandOption[]>,
): CommandsCapability {
  const catalogs = async (id: string, signal?: AbortSignal): Promise<{
    raw: Awaited<ReturnType<OpenCodeClient["session"]["get"]>>;
    options: CommandOption[];
  }> => {
    const c = client(),
      raw = await c.read(
        (api) => api.session.get({ sessionID: ids.decode(id) }, { signal }),
        signal,
      );
    const location = raw.location;
    if (list) return { raw, options: await list(id, signal) };
    const [commands, skills] = await Promise.all([
      c.read((api) => api.command.list({ location }, { signal }), signal),
      c.read((api) => api.skill.list({ location }, { signal }), signal),
    ]);
    return {
      raw,
      options: mergeCommands(
        mapCommands(commands.data),
        mapSkills(skills.data),
      ),
    };
  };
  return {
    async listCommands(id, signal) {
      return (await catalogs(id, signal)).options;
    },
    async command(input, operation) {
      return await client().sequence(ids.decode(input.sessionID), async () => {
        const c = client(),
          { raw, options } = await catalogs(
            input.sessionID,
            operation?.signal,
          );
        const command = !input.skill
          ? options.find((v) =>
            v.name === input.command && v.source !== "skill" &&
            v.source !== "builtin"
          )
          : undefined;
        const selected = options.find((v) =>
          v.source === "skill" &&
          (input.skill?.id
            ? v.skillID === input.skill.id
            : v.name === (input.skill?.name ?? input.command))
        );
        const skill = !command && selected?.skillID
          ? { id: selected.skillID }
          : undefined;
        if (!command && !skill) {
          throw new OperationFailure(
            "rejected",
            "command",
            new HarnessError("command", "That command is no longer available"),
          );
        }
        const files = await commandFiles(
          input,
          raw.location.directory,
          policy,
          operation,
        );
        await selectAction(c, raw, input, operation);
        const submitSkillInput = !command &&
          (input.arguments.length > 0 || files.length > 0);
        await c.effect(
          (api) =>
            command
              ? api.session.command({
                sessionID: raw.id,
                name: command.name,
                text: input.arguments,
                files,
              })
              : api.experimental.session.skill({
                sessionID: raw.id,
                id: skill!.id,
                ...(submitSkillInput ? { resume: false } : {}),
              }),
          operation,
        );
        if (submitSkillInput) {
          await operation?.checkpoint("command-skill-activated", {
            kind: "command-skill-activated",
            value: { sessionID: input.sessionID, skillID: skill!.id },
          });
          // Arguments/files are a real input, not discardable activation options.
          // A pending revert hides the activation; prompt admission commits that
          // suffix, so include its ID on the new input in that case only.
          await c.effect(
            (api) =>
              api.session.prompt({
                sessionID: raw.id,
                text: input.arguments,
                files,
                ...(raw.revert ? { skills: [{ id: skill!.id }] } : {}),
              }),
            operation,
          );
        }
        if (operation) await c.settled(raw.id, operation);
      }, operation);
    },
  };
}
