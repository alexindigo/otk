// SPDX-License-Identifier: LGPL-3.0-only
import type { HarnessAdapter } from "../adapter/types.ts";
import { HarnessError } from "../adapter/types.ts";
import type { PromptInput } from "../../protocol/rpc.ts";
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
  adapter: HarnessAdapter,
  method: string,
  value: unknown,
  prefs: Prefs,
  frecency: Frecency,
): Promise<unknown> {
  const p = object(value);
  const sessionID = () => text(p, "sessionID")!;
  switch (method) {
    case "prefs.get":
      return prefs.get();
    case "frecency.list":
      return frecency.list((await adapter.getSession(sessionID())).directory);
    case "frecency.bump":
      frecency.bump(
        (await adapter.getSession(sessionID())).directory,
        text(p, "path")!,
      );
      return null;
    case "agents.list":
      return adapter.listAgents(sessionID());
    case "resources.list":
      return adapter.listResources(sessionID());
    case "prefs.set":
      return prefs.set(p.key, p.value);
    case "session.get":
      return adapter.getSession(sessionID());
    case "session.children":
      return adapter.listChildren(sessionID());
    case "session.messages": {
      if (
        !Number.isInteger(p.limit) || Number(p.limit) < 1 ||
        Number(p.limit) > 200
      ) throw new HarnessError("params", "limit must be 1..200");
      return adapter.listMessages(sessionID(), {
        limit: Number(p.limit),
        before: text(p, "before", true),
      });
    }
    case "session.create":
      return adapter.createSession({
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
      await adapter.prompt(input);
      return null;
    }
    case "find.files":
      return adapter.findFiles(sessionID(), text(p, "query", true) ?? "");
    case "session.abort":
      await adapter.abort(sessionID());
      return null;
    case "session.shell": {
      const model = p.model === undefined ? undefined : object(p.model);
      await adapter.shell({
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
    case "session.revert":
      return adapter.revert(sessionID(), text(p, "messageID")!);
    case "permission.list":
      return adapter.listPermissions(sessionID());
    case "question.list":
      return adapter.listQuestions(sessionID());
    case "question.reply": {
      if (
        !Array.isArray(p.answers) ||
        p.answers.some((values) =>
          !Array.isArray(values) ||
          values.some((value) => typeof value !== "string")
        )
      ) throw new HarnessError("params", "Expected question answer arrays");
      await adapter.answerQuestion(
        text(p, "requestID")!,
        p.answers as string[][],
      );
      return null;
    }
    case "question.reject":
      await adapter.answerQuestion(text(p, "requestID")!);
      return null;
    case "permission.reply": {
      if (!["once", "always", "reject"].includes(String(p.reply))) {
        throw new HarnessError("params", "Invalid permission reply");
      }
      await adapter.replyPermission({
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
