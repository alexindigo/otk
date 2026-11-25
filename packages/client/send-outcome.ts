// SPDX-License-Identifier: LGPL-3.0-only
import { type PublicFailure, randomID } from "@otk/protocol";
import { FeedbackFailure, RequestFailure } from "./failures.ts";
import { presentFailure } from "./failure-features.ts";

/** Native admission, refusal and observation never collapse into void success. */
export type SendOutcome =
  | { kind: "committed"; messageID: string }
  /** Native accepted a send whose pending transcript entry carries its
   * identity. That entry owns commitment in place or its bounded observation
   * failure with Retry (2.39). */
  | { kind: "accepted"; messageID: string }
  | { kind: "refused"; reason: string; failure?: PublicFailure }
  | {
    kind: "failed";
    certainty: "definite" | "uncertain";
    reason: string;
    retry(): void;
    failure?: PublicFailure;
  }
  | { kind: "unconfirmed"; reason: string; failure?: PublicFailure };

export function refusedSend(cause: unknown): SendOutcome {
  const failure = cause instanceof RequestFailure ? cause.failure : undefined;
  return {
    kind: "refused",
    reason: failure?.facts?.reason ??
      "The message could not be prepared for sending.",
    ...(failure ? { failure } : {}),
  };
}

/** Report non-success through the existing structured failure presenter. */
export function requireCommittedSend(outcome: SendOutcome): void {
  if (outcome.kind === "committed" || outcome.kind === "accepted") return;
  const uncertain = outcome.kind === "unconfirmed" ||
    outcome.kind === "failed" && outcome.certainty === "uncertain";
  const feedback = presentFailure(
    outcome.failure ?? {
      code: `send.${outcome.kind}`,
      diagnosticID: randomID(),
      retry: "none",
      facts: {
        actionLabel: "Sending message",
        origin: "composer",
        ...(uncertain ? { outcome: "unknown" as const } : {}),
        reason: outcome.reason,
        recovery: uncertain
          ? "Check the session's latest messages before sending it again."
          : "The draft is retained. Resolve the stated reason before retrying.",
      },
    },
  );
  throw new FeedbackFailure({
    ...feedback,
    ...(outcome.kind === "failed" && !feedback.failure?.reference
      ? { action: { label: "Retry", run: outcome.retry } }
      : {}),
  });
}
