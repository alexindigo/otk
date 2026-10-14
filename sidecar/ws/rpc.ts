// SPDX-License-Identifier: LGPL-3.0-only
import {
  type CapabilityName,
  type Harness,
  HarnessError,
  requireCapability,
} from "@otk/harness";
import type { PromptInput, PromptPart } from "@otk/protocol";
import type { Prefs } from "../db/prefs.ts";
import { promptParts } from "./prompt.ts";
import type { Frecency } from "../db/frecency.ts";
export function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new HarnessError("params", "Expected object");
  }
  return value as Record<string, unknown>;
}
export function text(
  params: Record<string, unknown>,
  key: string,
  optional = false,
): string | undefined {
  const value = params[key];
  if (optional && value === undefined) return undefined;
  if (typeof value !== "string" || (!optional && value.length === 0)) {
    throw new HarnessError("params", `Expected ${key} string`);
  }
  return value as string;
}
export async function dispatch(
  adapter: Harness,
  method: string,
  value: unknown,
  prefs: Prefs,
  frecency: Frecency,
): Promise<unknown> {
  const p = object(value);
  const cap = <K extends CapabilityName>(name: K) =>
    requireCapability(adapter.capabilities, name);
  const sessionID = () => text(p, "sessionID")!;
  switch (method) {
    case "prefs.get":
      return prefs.get();
    case "frecency.list":
      return frecency.list(
        (await adapter.core.getSession(sessionID())).directory,
      );
    case "frecency.bump":
      frecency.bump(
        (await adapter.core.getSession(sessionID())).directory,
        text(p, "path")!,
      );
      return null;
    case "agents.list":
      return cap("agents").listAgents(sessionID());
    case "resources.list":
      return cap("resources").listResources(sessionID());
    case "prefs.set":
      return prefs.set(p.key, p.value);
    case "session.get":
      return adapter.core.getSession(sessionID());
    case "session.children":
      return adapter.core.listChildren(sessionID());
    case "session.messages": {
      if (
        !Number.isInteger(p.limit) || Number(p.limit) < 1 ||
        Number(p.limit) > 200
      ) throw new HarnessError("params", "limit must be 1..200");
      return adapter.core.listMessages(sessionID(), {
        limit: Number(p.limit),
        before: text(p, "before", true),
      });
    }
    case "session.create":
      return adapter.core.createSession({
        directory: text(p, "directory")!,
        title: text(p, "title", true),
        parentID: text(p, "parentID", true),
      });
    case "session.prompt": {
      const parts = promptParts(p.parts);
      if (p.mode !== "normal") {
        throw new HarnessError("params", "Expected normal prompt mode");
      }
      const input: PromptInput = {
        sessionID: sessionID(),
        parts,
        mode: "normal",
        agent: text(p, "agent", true),
        variant: text(p, "variant", true),
      };
      if (p.model !== undefined) {
        const model = object(p.model);
        input.model = {
          provider: text(model, "provider")!,
          model: text(model, "model")!,
        };
      }
      await cap("prompt").prompt(input);
      return null;
    }
    case "find.files":
      return cap("files").findFiles(sessionID(), text(p, "query", true) ?? "");
    case "session.abort":
      await cap("prompt").abort(sessionID());
      return null;
    case "session.shell": {
      const model = p.model === undefined ? undefined : object(p.model);
      await cap("shell").shell({
        sessionID: sessionID(),
        command: text(p, "command")!,
        agent: text(p, "agent", true),
        ...(model
          ? {
            model: {
              provider: text(model, "provider")!,
              model: text(model, "model")!,
            },
          }
          : {}),
      });
      return null;
    }
    case "commands.list":
      return cap("commands").listCommands(sessionID());
    case "history.list":
      return await cap("history").listHistory();
    case "history.attachment":
      return await cap("history").attachment({
        messageID: text(p, "messageID")!,
        partID: text(p, "partID")!,
      });
    case "session.command": {
      const model = p.model === undefined ? undefined : object(p.model),
        parts = p.parts === undefined ||
            (Array.isArray(p.parts) && p.parts.length === 0)
          ? []
          : promptParts(p.parts);
      if (parts.some((part) => part.kind !== "file")) {
        throw new HarnessError(
          "params",
          "Commands accept file attachments only",
        );
      }
      await cap("commands").command({
        sessionID: sessionID(),
        command: text(p, "command")!,
        arguments: text(p, "arguments", true) ?? "",
        agent: text(p, "agent", true),
        variant: text(p, "variant", true),
        parts: parts as Extract<PromptPart, { kind: "file" }>[],
        ...(model
          ? {
            model: {
              provider: text(model, "provider")!,
              model: text(model, "model")!,
            },
          }
          : {}),
      });
      return null;
    }
    case "session.revert":
      return cap("revert").revert(sessionID(), text(p, "messageID")!);
    case "permission.list":
      return cap("permissions").listPermissions(sessionID());
    case "question.list":
      return cap("questions").listQuestions(sessionID());
    case "question.reply": {
      if (
        !Array.isArray(p.answers) ||
        p.answers.some((values) =>
          !Array.isArray(values) ||
          values.some((value) => typeof value !== "string")
        )
      ) throw new HarnessError("params", "Expected question answer arrays");
      await cap("questions").answerQuestion(
        text(p, "requestID")!,
        p.answers as string[][],
      );
      return null;
    }
    case "question.reject":
      await cap("questions").answerQuestion(text(p, "requestID")!);
      return null;
    case "permission.reply": {
      if (!["once", "always", "reject"].includes(String(p.reply))) {
        throw new HarnessError("params", "Invalid permission reply");
      }
      await cap("permissions").replyPermission({
        sessionID: sessionID(),
        requestID: text(p, "requestID")!,
        reply: p.reply as "once" | "always" | "reject",
        message: text(p, "message", true),
      });
      return null;
    }
    default:
      throw new HarnessError("method", `Unknown method: ${method}`);
  }
}
