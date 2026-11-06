// SPDX-License-Identifier: LGPL-3.0-only
import { type Harness, HarnessError } from "@otk/harness";
import type { HistoryAttachmentRef } from "@otk/protocol";
import type { RpcRegistry } from "../ws/registry.ts";
import { text } from "../ws/params.ts";
import { readExecution } from "../requests/policies.ts";

export function register(rpc: RpcRegistry, harness: Harness): void {
  const capability = harness.capabilities.history;
  if (!capability) return;
  rpc.register("history.list", {
    execution: readExecution(() => ({ resource: "prompt-history" })),
    params: () => undefined,
    handler: (ctx) => {
      const view = ctx.request?.view?.();
      const directory = view?.directory ??
        (view?.selected
          ? ctx.sessionMetadata?.(view.selected)?.directory
          : undefined);
      // An unopened/discovered project is never an implicit history source.
      if (ctx.request && !directory) return [];
      return capability.listHistory(ctx.execution?.signal, directory);
    },
  });
  rpc.register("history.attachments", {
    execution: readExecution((refs: HistoryAttachmentRef[]) => ({
      resource: JSON.stringify(refs),
    })),
    params: (p) => {
      if (!Array.isArray(p.refs)) {
        throw new HarnessError("params", "Expected attachment references");
      }
      const refs = p.refs.map((ref) => {
        if (!ref || typeof ref !== "object") {
          throw new HarnessError("params", "Expected attachment reference");
        }
        return {
          messageID: text(ref, "messageID")!,
          partID: text(ref, "partID")!,
        };
      });
      if (
        new Set(refs.map((ref) => JSON.stringify(ref))).size !== refs.length
      ) {
        throw new HarnessError(
          "params",
          "Expected unique attachment references",
        );
      }
      return refs;
    },
    handler: async (ctx, refs) => ({
      items: await capability.attachments(refs, ctx.execution?.signal),
    }),
  });
}
