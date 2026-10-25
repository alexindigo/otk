// SPDX-License-Identifier: LGPL-3.0-only
import { type Harness, HarnessError } from "@otk/harness";
import type { RpcRegistry } from "../ws/registry.ts";
import { text } from "../ws/params.ts";

export function register(rpc: RpcRegistry, harness: Harness): void {
  const actions = harness.capabilities.sessionActions;
  if (!actions) return;
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
