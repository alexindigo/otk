// SPDX-License-Identifier: LGPL-3.0-only
import { type Harness, HarnessError } from "@otk/harness";
import type { RpcRegistry } from "../ws/registry.ts";
import { sessionID, text } from "../ws/params.ts";
import { MAX_MESSAGE_CURSOR_LENGTH } from "@otk/protocol";

export function register(
  rpc: RpcRegistry,
  _harness: Harness,
  created?: (directory: string) => void,
): void {
  rpc.register("session.get", {
    params: (p) => sessionID(p)!,
    handler: (ctx, id) => ctx.harness.core.getSession(id),
  });
  rpc.register("session.children", {
    params: (p) => sessionID(p)!,
    handler: (ctx, id) => ctx.harness.core.listChildren(id),
  });
  rpc.register("session.messages", {
    params(p) {
      if (
        Object.keys(p).some((key) => key !== "sessionID" && key !== "before")
      ) throw new HarnessError("params", "Unknown message page parameter");
      const before = text(p, "before", true);
      if (
        before !== undefined &&
        (!before.length || before.length > MAX_MESSAGE_CURSOR_LENGTH)
      ) throw new HarnessError("params", "Invalid message cursor length");
      return {
        sessionID: sessionID(p)!,
        before,
      };
    },
    handler: (ctx, p) =>
      ctx.harness.core.listMessages(p.sessionID, {
        before: p.before,
      }, ctx.execution?.signal),
  });
  rpc.register("session.create", {
    params: (p) => ({
      directory: text(p, "directory")!,
      title: text(p, "title", true),
      parentID: sessionID(p, "parentID", true),
    }),
    async handler(ctx, p) {
      const session = await ctx.harness.core.createSession(p);
      created?.(session.directory);
      return session;
    },
  });
}
