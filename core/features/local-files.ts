// SPDX-License-Identifier: LGPL-3.0-only
import { HarnessError } from "@otk/harness";
import { MAX_STAT_PATHS } from "@otk/protocol";
import type { InlineImages } from "../files/inline-images.ts";
import type { LocalFiles } from "../files/local-files.ts";
import { readExecution } from "../requests/policies.ts";
import { sessionID, text } from "../ws/params.ts";
import type { RpcRegistry } from "../ws/registry.ts";

function pathBatch(p: Record<string, unknown>) {
  const { paths } = p;
  if (
    !Array.isArray(paths) || paths.length > MAX_STAT_PATHS ||
    paths.some((path) => typeof path !== "string")
  ) {
    throw new HarnessError(
      "params",
      "Expected a bounded list of local file paths",
    );
  }
  return { sessionID: sessionID(p)!, paths: paths as string[] };
}

export function registerLocalFiles(
  rpc: RpcRegistry,
  files: LocalFiles,
  images: InlineImages,
): void {
  rpc.register("file.stat", {
    params: pathBatch,
    execution: readExecution((p: { sessionID: string }) => ({
      sessionID: p.sessionID,
    })),
    handler: async (ctx, p) =>
      files.stat(
        await ctx.sessionDirectory(p.sessionID),
        p.paths,
        ctx.execution?.signal,
      ),
  });
  rpc.register("file.images", {
    params: pathBatch,
    execution: readExecution((p: { sessionID: string }) => ({
      sessionID: p.sessionID,
    })),
    async handler(ctx, p) {
      const signal = ctx.execution?.signal;
      const directories = await ctx.sessionDirectories([p.sessionID], signal);
      return await images.facts(directories[p.sessionID], p.paths, signal);
    },
  });
  rpc.register("file.preview", {
    params: (p) => ({ sessionID: sessionID(p)!, path: text(p, "path")! }),
    execution: readExecution((p: { sessionID: string; path: string }) => ({
      sessionID: p.sessionID,
      resource: p.path,
    })),
    handler: async (ctx, p) =>
      files.preview(
        await ctx.sessionDirectory(p.sessionID),
        p.path,
        ctx.execution?.signal,
      ),
  });
}
