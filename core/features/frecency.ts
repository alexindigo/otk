// SPDX-License-Identifier: LGPL-3.0-only
import { HarnessError } from "@otk/harness";
import type { Frecency, FrecencyOptions } from "@otk/store";
import type { Harness } from "@otk/harness";
import type { RpcRegistry } from "../ws/registry.ts";
import { sessionID, text } from "../ws/params.ts";
import {
  localResultExecution,
  localWrite,
  metadataReceipt,
  readExecution,
} from "../requests/policies.ts";

const bumpReceipt = metadataReceipt("frecency-bumped", (value) => {
  if (
    !value || typeof value !== "object" || !("time" in value) ||
    !Number.isSafeInteger(value.time) || Number(value.time) < 0
  ) throw new TypeError("Invalid frecency receipt");
  return { time: Number(value.time) };
});

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
    execution: readExecution((id: string) => ({ sessionID: id })),
    params: (p) => sessionID(p)!,
    handler: async (ctx, id) => frecency.list(await ctx.sessionDirectory(id)),
  });
  rpc.register("frecency.bump", {
    execution: localResultExecution(
      (p: { sessionID: string }) => ({ sessionID: p.sessionID }),
      bumpReceipt,
      () => null,
    ),
    // Path validation stays after authoritative session lookup, as before.
    params: (p) => ({ sessionID: sessionID(p)!, value: p }),
    async handler(ctx, p) {
      const directory = await ctx.sessionDirectory(p.sessionID);
      const path = text(p.value, "path")!;
      localWrite(ctx, (tx) => {
        return { time: frecency.bump(directory, path, tx) };
      }, bumpReceipt);
      return null;
    },
  });
}
