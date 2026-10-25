// SPDX-License-Identifier: LGPL-3.0-only
import { type Harness, HarnessError } from "@otk/harness";
import type { RpcRegistry } from "../ws/registry.ts";
import { object, text } from "../ws/params.ts";

export function register(
  rpc: RpcRegistry,
  harness: Harness,
  created?: (directory: string) => void,
): void {
  const actions = harness.capabilities.sessionActions;
  if (!actions) return;
  rpc.register("session.compact", {
    params(p) {
      const model = object(p.model);
      return {
        sessionID: text(p, "sessionID")!,
        model: {
          provider: text(model, "provider")!,
          model: text(model, "model")!,
        },
      };
    },
    async handler(_ctx, p) {
      await actions.compact(p.sessionID, p.model);
      return null;
    },
  });
  rpc.register("session.fork", {
    params: (p) => ({
      sessionID: text(p, "sessionID")!,
      through: p.through === undefined ? undefined : text(p, "through"),
    }),
    async handler(_ctx, p) {
      const session = await actions.fork(p.sessionID, p.through);
      created?.(session.directory);
      return session;
    },
  });
  rpc.register("session.delete", {
    params: (p) => text(p, "sessionID")!,
    async handler(_ctx, id) {
      await actions.remove(id);
      return null;
    },
  });
  rpc.register("session.rename", {
    params(p) {
      const sessionID = text(p, "sessionID")!;
      const title = text(p, "title")!.trim();
      if (!title || title.length > 200) {
        throw new HarnessError("params", "title must be 1..200 characters");
      }
      return { sessionID, title };
    },
    handler: (_ctx, p) => actions.rename(p.sessionID, p.title),
  });
}
