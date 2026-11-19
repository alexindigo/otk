// SPDX-License-Identifier: LGPL-3.0-only
import {
  type FailureFacts,
  OperationFailure,
  type PublicFailure,
} from "@otk/protocol";
import { HarnessError } from "@otk/harness";
import { storageProblem } from "@otk/store";

export function storageFailure(
  problem: "full" | "io",
  diagnosticID: string = crypto.randomUUID(),
): PublicFailure {
  return {
    code: `storage.${problem}`,
    retry: "same-intent",
    diagnosticID,
    facts: {
      actionLabel: "Saving changes",
      reason: problem === "full"
        ? "Storage is full: OTK can't save changes. Free disk space; OTK resumes automatically."
        : "Storage is unavailable: OTK can't save changes. Restore disk access; OTK resumes automatically.",
    },
  };
}
/** Explicit semantic failures only; arbitrary exceptions remain diagnostic causes. */
export class ExecutionFailure extends Error {
  constructor(readonly failure: Omit<PublicFailure, "diagnosticID">) {
    super("Request rejected");
  }
}
export function publicFailure(
  cause: unknown,
  report: (id: string, cause: unknown) => void,
  context?: FailureFacts,
): PublicFailure {
  const diagnosticID = cause instanceof OperationFailure
    ? cause.diagnosticID
    : crypto.randomUUID();
  try {
    report(diagnosticID, cause);
  } catch { /* Diagnostics cannot change an outcome. */ }
  const problem = storageProblem(cause);
  if (problem) {
    const failure = storageFailure(problem, diagnosticID);
    return { ...failure, facts: { ...context, ...failure.facts } };
  }
  return {
    ...(cause instanceof ExecutionFailure
      ? cause.failure
      : cause instanceof HarnessError
      ? {
        code: cause.code === "method" || cause.code === "params"
          ? `request.${cause.code}`
          : cause.code,
        retry: "new-intent" as const,
      }
      : cause instanceof OperationFailure
      ? {
        code: cause.code,
        retry: cause.outcome === "unknown"
          ? "none" as const
          : cause.outcome === "unavailable"
          ? "same-intent" as const
          : "new-intent" as const,
      }
      : { code: "action.rejected", retry: "new-intent" as const }),
    diagnosticID,
    facts: {
      ...context,
      ...(cause instanceof ExecutionFailure
        ? cause.failure.facts
        : cause instanceof OperationFailure || cause instanceof HarnessError
        ? cause.facts
        : undefined),
      ...(cause instanceof OperationFailure ? { outcome: cause.outcome } : {}),
    },
  };
}
