// SPDX-License-Identifier: LGPL-3.0-only
import type { HarnessAdapter } from "../adapter/types.ts";
import { HarnessError } from "../adapter/types.ts";
import type { PromptInput } from "../../protocol/rpc.ts";
import type { Prefs } from "../db/prefs.ts";
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
): Promise<unknown> {
  const p = object(value);
  const sessionID = () => text(p, "sessionID")!;
  switch (method) {
    case "prefs.get":
      return prefs.get();
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
      if (!Array.isArray(p.parts) || p.parts.length === 0) {
        throw new HarnessError("params", "parts required");
      }
      const parts = p.parts.map((part) => {
        const item = object(part);
        if (item.type !== "text") {
          throw new HarnessError("params", "M1 accepts text parts only");
        }
        return { type: "text" as const, text: text(item, "text")! };
      });
      const input: PromptInput = {
        sessionID: sessionID(),
        parts,
        agent: text(p, "agent", true),
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
    case "session.abort":
      await adapter.abort(sessionID());
      return null;
    case "session.revert":
      return adapter.revert(sessionID(), text(p, "messageID")!);
    case "permission.list":
      return adapter.listPermissions(sessionID());
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
