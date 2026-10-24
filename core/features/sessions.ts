// SPDX-License-Identifier: LGPL-3.0-only
import { type Harness, HarnessError } from "@otk/harness";
import type { RpcRegistry } from "../ws/registry.ts";
import { text } from "../ws/params.ts";

export function register(
  rpc: RpcRegistry,
  _harness: Harness,
  created?: (directory: string) => void,
): void {
  rpc.register("session.get", {
    params: (p) => text(p, "sessionID")!,
    handler: (ctx, id) => ctx.harness.core.getSession(id),
  });
  rpc.register("session.children", {
    params: (p) => text(p, "sessionID")!,
    handler: (ctx, id) => ctx.harness.core.listChildren(id),
  });
  rpc.register("session.messages", {
    params(p) {
      if (
        !Number.isInteger(p.limit) || Number(p.limit) < 1 ||
        Number(p.limit) > 200
      ) {
        throw new HarnessError("params", "limit must be 1..200");
      }
      return {
        sessionID: text(p, "sessionID")!,
        limit: Number(p.limit),
        before: text(p, "before", true),
      };
    },
    handler: (ctx, p) =>
      ctx.harness.core.listMessages(p.sessionID, {
        limit: p.limit,
        before: p.before,
      }),
  });
  rpc.register("session.create", {
    params: (p) => ({
      directory: text(p, "directory")!,
      title: text(p, "title", true),
      parentID: text(p, "parentID", true),
    }),
    async handler(ctx, p) {
      const session = await ctx.harness.core.createSession(p);
      created?.(session.directory);
      return session;
    },
  });
}
