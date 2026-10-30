// SPDX-License-Identifier: LGPL-3.0-only
import type { PublicFailure, RequestProgress } from "@otk/protocol";
export interface Feedback {
  /** Opaque operation and failure correlation, never display copy. */
  identity?: string;
  diagnosticID?: string;
  kind: "pending" | "connection" | "error" | "info";
  text: string;
  field?: string;
  action?: { label: string; run(): void };
}
export interface FeedbackOwner {
  current(): Feedback | undefined;
  subscribe(listener: () => void): () => void;
  fail(cause: unknown): void;
  clear(): void;
}
export class RequestFailure extends Error {
  constructor(readonly failure: PublicFailure) {
    super("Could not finish this action");
  }
}
export class RequestReleased extends Error {
  constructor() {
    super("Request released");
    this.name = "RequestReleased";
  }
}
export class FailurePresenter {
  #contributions = new Map<string, (failure: PublicFailure) => Feedback>();
  register(code: string, present: (failure: PublicFailure) => Feedback): void {
    if (this.#contributions.has(code)) {
      throw new Error("Duplicate failure presentation");
    }
    this.#contributions.set(code, present);
  }
  present(failure: PublicFailure): Feedback {
    const feedback = this.#contributions.get(failure.code)?.(failure) ??
      {
        kind: "error",
        text: "Could not finish this action. Try again",
        ...(failure.field ? { field: failure.field } : {}),
      };
    return feedback;
  }
  progress(progress: RequestProgress): Feedback {
    const text: Record<RequestProgress["code"], string> = {
      queued: "Waiting to start",
      working: "Working",
      stopping: "Stopping session",
      publishing: "Updating the conversation",
      "backend-unavailable": "Waiting for the server",
      "checking-outcome": "Checking whether this finished",
      "input-required": "Review the input to continue",
    };
    return { kind: "pending", text: text[progress.code] };
  }
  connection(): Feedback {
    return {
      kind: "connection",
      text: "Reconnecting. Your pending action is kept.",
    };
  }
}
/** Browser exceptions are diagnostics, never display copy. */
export function localFailure(
  cause: unknown,
  diagnostic: (id: string, cause: unknown) => void,
): PublicFailure {
  const diagnosticID = crypto.randomUUID();
  try {
    diagnostic(diagnosticID, cause);
  } catch { /* Diagnostics do not replace failure facts. */ }
  return { code: "action.local", retry: "new-intent", diagnosticID };
}

/** One entry for definite failures and local exceptions; release is silent. */
export function failureFeedback(
  cause: unknown,
  presenter: FailurePresenter,
  diagnostic: (id: string, cause: unknown) => void = () => {},
): Feedback | undefined {
  if (cause instanceof RequestReleased) return undefined;
  return presenter.present(
    cause instanceof RequestFailure
      ? cause.failure
      : localFailure(cause, diagnostic),
  );
}
