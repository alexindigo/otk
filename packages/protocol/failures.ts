// SPDX-License-Identifier: LGPL-3.0-only
/** Neutral certainty facts. The cause stays diagnostic, never display copy. */
export class OperationFailure extends Error {
  constructor(
    readonly outcome: "unknown" | "unavailable" | "rejected",
    readonly code: string,
    cause: unknown,
  ) {
    super("The operation has not completed", { cause });
  }
}
