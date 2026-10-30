// SPDX-License-Identifier: LGPL-3.0-only
import { OperationFailure, type PublicFailure } from "@otk/protocol";
/** Explicit semantic failures only; arbitrary exceptions remain diagnostic causes. */
export class ExecutionFailure extends Error {
  constructor(readonly failure: Omit<PublicFailure, "diagnosticID">) {
    super("Request rejected");
  }
}
export function publicFailure(
  cause: unknown,
  report: (id: string, cause: unknown) => void,
): PublicFailure {
  const diagnosticID = crypto.randomUUID();
  try {
    report(diagnosticID, cause);
  } catch { /* Diagnostics cannot change an outcome. */ }
  return {
    ...(cause instanceof ExecutionFailure
      ? cause.failure
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
  };
}
