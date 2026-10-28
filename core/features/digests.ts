// SPDX-License-Identifier: LGPL-3.0-only
import { type Harness, HarnessError } from "@otk/harness";
import { isSessionID } from "@otk/protocol";
import { text } from "../ws/params.ts";
import type { RpcRegistry } from "../ws/registry.ts";
import { projectPath } from "./project-scan.ts";
export function registerDigests(rpc: RpcRegistry, harness: Harness): void {
  const port = harness.capabilities.digests;
  if (!port) return;
  const owners = new Set<string>();
  rpc.register("digests.scope", {
    params(p) {
      if (
        !Array.isArray(p.sessions) || !p.sessions.every(isSessionID) ||
        new Set(p.sessions).size !== p.sessions.length
      ) throw new HarnessError("params", "Expected unique qualified sessions");
      const directory = p.directory === undefined
        ? undefined
        : projectPath(text(p, "directory")!);
      return { directory, sessions: p.sessions as string[] };
    },
    handler(ctx, value) {
      const request = ctx.request;
      if (!request || request.signal.aborted) {
        throw new HarnessError(
          "request",
          "Visible scope requires a live connection lifetime",
        );
      }
      if (!owners.has(request.id)) {
        owners.add(request.id);
        request.defer(() => {
          owners.delete(request.id);
          port.release(request.id);
        });
      }
      port.scope(request.id, value);
      return null;
    },
  });
}
