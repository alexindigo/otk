// SPDX-License-Identifier: LGPL-3.0-only
import { FailureCause, OperationFailure } from "./failures.ts";
import type { PublicFailure } from "./requests.ts";

/** Transport projections retain explicitly published facts, never arbitrary exception prose. */
export function preserveFailure(
  cause: unknown,
  value: PublicFailure,
): PublicFailure {
  const known =
    cause instanceof FailureCause || cause instanceof OperationFailure
      ? cause
      : undefined;
  return {
    ...value,
    diagnosticID: cause instanceof OperationFailure
      ? cause.diagnosticID
      : value.diagnosticID,
    facts: { ...value.facts, ...known?.facts },
  };
}
