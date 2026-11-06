// SPDX-License-Identifier: LGPL-3.0-only
import { HarnessError } from "@otk/harness";
import type { Frecency, FrecencyOptions } from "@otk/store";
import type { Harness } from "@otk/harness";
import type { RpcRegistry } from "../ws/registry.ts";
import { sessionID, text } from "../ws/params.ts";
import { MAX_NATIVE_PATH, projectPath } from "./project-scan.ts";
import type { FrameSource } from "../ws/connections.ts";
import type { ServerFrame } from "@otk/protocol";
import {
  localWrite,
  metadataReceipt,
  preparedLocalResultExecution,
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
  maxLength: MAX_NATIVE_PATH,
  invalid: () =>
    new HarnessError("params", "Invalid frecency path length or value"),
};

export function register(
  rpc: RpcRegistry,
  _harness: Harness,
  frecency: Frecency,
): FrameSource {
  const revisions = new Map<string, number>();
  const listeners = new Set<(frame: ServerFrame) => void>();
  const stop = frecency.listen((change) => {
    const revision = (revisions.get(change.directory) ?? 0) + 1;
    revisions.set(change.directory, revision);
    for (const listener of listeners) {
      listener({ t: "frecency.patch", revision, ...change });
    }
  });
  rpc.register("frecency.list", {
    execution: readExecution((p: { sessionID?: string; directory?: string }) =>
      p
    ),
    params: (p): { sessionID?: string; directory?: string } =>
      p.sessionID !== undefined
        ? { sessionID: sessionID(p)! }
        : { directory: projectPath(text(p, "directory")!) },
    handler: async (ctx, p) => {
      const directory = p.directory ?? await ctx.sessionDirectory(p.sessionID!);
      return {
        directory,
        revision: revisions.get(directory) ?? 0,
        entries: frecency.list(directory),
      };
    },
  });
  rpc.register("frecency.bump", {
    execution: preparedLocalResultExecution(
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
  return {
    open(view) {
      return {
        listen(listener) {
          const receive = (frame: ServerFrame) => {
            const scope = view();
            const directory = scope.directory ??
              (scope.selected
                ? rpc.context.sessionMetadata?.(scope.selected)?.directory
                : undefined);
            if (frame.t === "frecency.patch" && frame.directory === directory) {
              listener(frame);
            }
          };
          listeners.add(receive);
          return () => {
            listeners.delete(receive);
          };
        },
      };
    },
    listen(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    close() {
      stop();
      listeners.clear();
    },
  };
}
