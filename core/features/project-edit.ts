// SPDX-License-Identifier: LGPL-3.0-only
import { type Harness, HarnessError } from "@otk/harness";
import {
  type ProjectEditField,
  type ProjectEditTarget,
  type ProjectPatch,
  sha256,
} from "@otk/protocol";
import type { RpcRegistry } from "../ws/registry.ts";
import { object, text } from "../ws/params.ts";
import {
  assertUncontestedRecovery,
  metadataReceipt,
  nativeEffect,
  nativeExecution,
  readExecution,
} from "../requests/policies.ts";
import { projectPath } from "./project-scan.ts";

const fields: readonly ProjectEditField[] = [
  "name",
  "icon",
  "color",
  "startScript",
];
const target = (value: unknown): ProjectEditTarget => {
  const p = object(value);
  return {
    directory: projectPath(text(p, "directory")!),
    projectID: text(p, "projectID")!,
  };
};
const edited = metadataReceipt("project-edited", target);
const intent = metadataReceipt("project-edit-intent", (value) => {
  const p = object(value), hashes = object(p.hashes);
  if (
    !Object.entries(hashes).every(([key, hash]) =>
      fields.includes(key as ProjectEditField) && typeof hash === "string" &&
      /^[a-f0-9]{64}$/.test(hash)
    )
  ) throw new TypeError("Invalid project edit witness");
  return {
    ...target(value),
    hashes: hashes as Partial<Record<ProjectEditField, string>>,
  };
});
export function registerProjectEdit(rpc: RpcRegistry, harness: Harness): void {
  const capability = harness.capabilities.projectEdit;
  if (!capability) return;
  rpc.register("project.settings", {
    execution: readExecution((p: { directory: string }) => ({
      directory: p.directory,
    })),
    params: (p) => ({ directory: projectPath(text(p, "directory")!) }),
    handler: (ctx, p) => capability.read(p.directory, ctx.execution?.signal),
  });
  rpc.register("project.update", {
    execution: {
      ...nativeExecution(
        (p: ProjectEditTarget) => ({
          directory: p.directory,
          resource: `project:${p.projectID}`,
        }),
        edited,
      ),
      ordering: "target",
      checkpoint: (receipt) =>
        receipt.kind === intent.kind
          ? intent.validate(receipt)
          : edited.validate(receipt),
      recover: async (ctx, record, execution) => {
        if (record.receipt_kind === edited.kind) {
          edited.restore(record);
          return { state: "complete", result: null };
        }
        if (record.receipt_kind === intent.kind) {
          // Older versions could settle a successful readback with the intent
          // witness still attached. The durable terminal state is authoritative.
          if (record.state === "succeeded") {
            return { state: "complete", result: null };
          }
          assertUncontestedRecovery(ctx, record);
          const expected = intent.restore(record);
          const current = await capability.read(
            expected.directory,
            execution.signal,
          );
          const matches = current.projectID === expected.projectID &&
            (await Promise.all(
              Object.entries(expected.hashes).map(async ([field, hash]) =>
                await sha256(current.values[field as ProjectEditField]) === hash
              ),
            )).every(Boolean);
          assertUncontestedRecovery(ctx, record);
          if (matches) {
            await execution.checkpoint(edited.kind, edited.encode(expected));
            return { state: "complete", result: null };
          }
        }
        return {
          state: "pending",
          progress: { phase: "reconciling", code: "checking-outcome" },
        };
      },
      receipt: () => undefined,
    },
    params(p) {
      const patch = object(p.patch);
      if (
        !Object.keys(patch).length ||
        !Object.entries(patch).every(([key, value]) =>
          fields.includes(key as ProjectEditField) && typeof value === "string"
        )
      ) throw new HarnessError("params", "Expected writable project fields");
      return { ...target(p), patch: patch as ProjectPatch };
    },
    async handler(ctx, p) {
      const ready = capability.read(
        p.directory,
        ctx.execution?.signal,
      );
      const snapshot = await (ctx.execution?.wait?.(ready) ?? ready);
      if (
        snapshot.projectID !== p.projectID ||
        Object.keys(p.patch).some((key) =>
          !snapshot.fields.includes(key as ProjectEditField)
        )
      ) {
        throw new HarnessError(
          "project.target",
          "The project or its writable fields changed. Reopen project settings.",
        );
      }
      await ctx.execution?.checkpoint(
        intent.kind,
        intent.encode({
          ...target(p),
          hashes: Object.fromEntries(
            await Promise.all(
              Object.entries(p.patch).map(async (
                [key, value],
              ) => [key, await sha256(value)]),
            ),
          ),
        }),
      );
      await nativeEffect(ctx, async (operation) => {
        const result = await capability.update(p, p.patch, operation);
        if (
          result.projectID !== p.projectID ||
          Object.entries(p.patch).some(([key, value]) =>
            result.values[key as ProjectEditField] !== value
          )
        ) {
          throw new HarnessError(
            "project.readback",
            "Project settings could not be confirmed. Reopen settings to check the native values.",
          );
        }
        return target(p);
      }, edited);
      return null;
    },
  });
}
