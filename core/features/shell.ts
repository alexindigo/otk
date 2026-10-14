// SPDX-License-Identifier: LGPL-3.0-only
import type { Harness } from "@otk/harness";
import type { RpcRegistry } from "../ws/registry.ts";
import { object, text } from "../ws/params.ts";

export function register(rpc: RpcRegistry, harness: Harness): void {
  const capability = harness.capabilities.shell;
  if (!capability) return;
  rpc.register("session.shell", {
    params(p) {
      const model = p.model === undefined ? undefined : object(p.model);
      return {
        sessionID: text(p, "sessionID")!,
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
      };
    },
    async handler(_ctx, input) {
      await capability.shell(input);
      return null;
    },
  });
}
