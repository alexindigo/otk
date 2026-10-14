// SPDX-License-Identifier: LGPL-3.0-only
import { HarnessError } from "@otk/harness";
import type { Frecency, FrecencyOptions } from "@otk/store";
import type { Harness } from "@otk/harness";
import type { RpcRegistry } from "../ws/registry.ts";
import { text } from "../ws/params.ts";

export const frecencyOptions: FrecencyOptions = {
  invalid: () =>
    new HarnessError("params", "Invalid frecency path length or value"),
};

export function register(
  rpc: RpcRegistry,
  _harness: Harness,
  frecency: Frecency,
): void {
  rpc.register("frecency.list", {
    params: (p) => text(p, "sessionID")!,
    handler: async (ctx, id) => frecency.list(await ctx.sessionDirectory(id)),
  });
  rpc.register("frecency.bump", {
    // Path validation stays after authoritative session lookup, as before.
    params: (p) => ({ sessionID: text(p, "sessionID")!, value: p }),
    async handler(ctx, p) {
      frecency.bump(
        await ctx.sessionDirectory(p.sessionID),
        text(p.value, "path")!,
      );
      return null;
    },
  });
}
