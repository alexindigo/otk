// SPDX-License-Identifier: LGPL-3.0-only
import type { FailureFacts } from "./requests.ts";
/** Summary-only projection. Credential-bearing prose stays diagnostic; no raw view is introduced. */
export function publicFailureReason(
  reason: string,
  credentials: readonly string[] = [],
): string {
  const credentialText =
    /\b(?:authorization|proxy-authorization|cookie|set-cookie|password|passwd|secret|token|api[_-]?key|receipt[_-]?secret|private[_-]?key)["']?\s*[:=]|\b(?:Basic|Bearer)\s+[A-Za-z0-9+/_=-]+|-----BEGIN[^\n]*PRIVATE KEY-----/i;
  return credentialText.test(reason) ||
      credentials.some((value) => value && reason.includes(value))
    ? "The native reason contains credential data and is not shown"
    : reason;
}
/** Only the producer can select public facts; generic boundaries never read Error.message. */
export class FailureCause extends Error {
  constructor(message: string, readonly facts: FailureFacts, cause?: unknown) {
    super(message, { cause });
    if (facts.reason) {
      this.facts = { ...facts, reason: publicFailureReason(facts.reason) };
    }
  }
}
/** Neutral certainty and explicitly projected facts. The original cause stays diagnostic. */
export class OperationFailure extends Error {
  readonly diagnosticID: string;
  constructor(
    readonly outcome: "unknown" | "unavailable" | "rejected",
    readonly code: string,
    cause: unknown,
    readonly facts: FailureFacts | undefined =
      cause instanceof FailureCause || cause instanceof OperationFailure
        ? cause.facts
        : undefined,
    diagnosticID?: string,
  ) {
    super("The operation has not completed", { cause });
    this.diagnosticID = diagnosticID ??
      (cause instanceof OperationFailure
        ? cause.diagnosticID
        : crypto.randomUUID());
  }
}
