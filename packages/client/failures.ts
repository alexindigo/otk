// SPDX-License-Identifier: LGPL-3.0-only
import type {
  FailureFacts,
  FailureTarget,
  PublicFailure,
  RequestProgress,
} from "@otk/protocol";
export interface FailurePresentation {
  value: PublicFailure;
  action: string;
  heading: string;
  target: { label: string; href?: string };
  reason: string;
  recovery: string;
  count: number;
  occurrences: readonly string[];
  /** No feature-authored reason: Details carry the diagnostic ID instead. */
  generic?: boolean;
}
/** Plain words when no owner published a reason; never jargon. */
export const GENERIC_FAILURE_REASON = "OTK has no further details";
export interface Feedback {
  /** Opaque operation and failure correlation, never display copy. */
  identity?: string;
  diagnosticID?: string;
  kind: "pending" | "connection" | "error" | "info";
  text: string;
  field?: string;
  action?: { label: string; run(): void };
  failure?: FailurePresentation;
}
export interface FeedbackOwner {
  current(): Feedback | undefined;
  subscribe(listener: () => void): () => void;
  fail(cause: unknown): void;
  clear(): void;
}
export class RequestFailure extends Error {
  constructor(readonly failure: PublicFailure) {
    super(failure.facts?.reason ?? "Request rejected");
  }
}
export class RequestReleased extends Error {
  constructor() {
    super("Request released");
    this.name = "RequestReleased";
  }
}
/** Feedback classified by a client feature owner, not arbitrary exception prose. */
export class FeedbackFailure extends Error {
  constructor(readonly feedback: Feedback) {
    super(feedback.text);
  }
}
export class FailurePresenter {
  #contributions = new Map<string, (failure: PublicFailure) => Feedback>();
  #groups = new Map<string, { identity: string; occurrences: Set<string> }>();
  constructor(
    readonly context: {
      action?(key: string): string;
      target?(target: FailureTarget): { label: string; href?: string };
    } = {},
  ) {}
  register(code: string, present: (failure: PublicFailure) => Feedback): void {
    if (this.#contributions.has(code)) {
      throw new Error("Duplicate failure presentation");
    }
    this.#contributions.set(code, present);
  }
  #present(failure: PublicFailure): Feedback {
    // Public facts are a wire DTO. Snapshot its owned object levels so a
    // framework-bound feedback value cannot leak proxies into delivery ports.
    const sourceFacts = failure.facts;
    failure = {
      ...failure,
      ...(sourceFacts
        ? {
          facts: {
            ...sourceFacts,
            ...(sourceFacts.target
              ? { target: { ...sourceFacts.target } }
              : {}),
          },
        }
        : {}),
    };
    const enrichment = this.#contributions.get(failure.code)?.(failure);
    const facts = failure.facts ?? {};
    const action = facts.action
      ? this.context.action?.(facts.action) ?? facts.action
      : "The requested action";
    const target = this.context.target?.(facts.target ?? {}) ??
      { label: facts.target?.label ?? "OTK" };
    const known = facts.reason ?? enrichment?.text;
    const reason = known ?? GENERIC_FAILURE_REASON;
    const status = facts.status === undefined ? "" : ` (HTTP ${facts.status})`;
    const pending = facts.outcome === "unknown" ||
      facts.outcome === "unavailable" || enrichment?.kind === "pending";
    const heading = pending
      ? `Checking whether ${action} finished`
      : `${action} failed`;
    const recovery = facts.recovery ??
      (pending
        ? "OTK is checking the original outcome and will not repeat the action without evidence"
        : failure.retry === "same-intent"
        ? "OTK will not repeat this action automatically. Review the target's current state"
        : failure.retry === "new-intent"
        ? "Review the target and input before starting a new action"
        : "OTK will not repeat this action. Review the target's current state");
    const presentation: FailurePresentation = {
      value: failure,
      action,
      heading,
      target,
      reason: reason + status,
      recovery,
      count: 1,
      occurrences: [failure.diagnosticID],
      ...(known ? {} : { generic: true }),
    };
    return {
      ...enrichment,
      kind: pending ? "pending" : "error",
      text:
        `${heading} for ${target.label}: ${presentation.reason}. ${recovery}.`,
      diagnosticID: failure.diagnosticID,
      field: failure.field ?? enrichment?.field,
      failure: presentation,
    };
  }
  /** The only grouping rule. Targets stay separate until decision 41 is settled. */
  groupingKey(failure: PublicFailure): string {
    const shown = this.#present(failure).failure!;
    const target = failure.facts?.target;
    return JSON.stringify([
      target?.sidecarId ?? "local",
      target?.sessionID ?? target?.directory ?? "OTK",
      shown.action,
      shown.reason,
      shown.recovery,
      failure.retry,
    ]);
  }
  describe(failure: PublicFailure): Feedback {
    return this.#present(failure);
  }
  present(failure: PublicFailure): Feedback {
    const key = this.groupingKey(failure);
    let group = this.#groups.get(key);
    if (!group) {
      group = { identity: crypto.randomUUID(), occurrences: new Set() };
      this.#groups.set(key, group);
    }
    group.occurrences.add(failure.diagnosticID);
    const value = this.#present(failure);
    return {
      ...value,
      identity: group.identity,
      failure: {
        ...value.failure!,
        count: group.occurrences.size,
        occurrences: [...group.occurrences],
      },
    };
  }
  group(failure: PublicFailure): Feedback {
    return this.present(failure);
  }
  forgetGroup(failure: PublicFailure): void {
    this.#groups.delete(this.groupingKey(failure));
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
  facts?: FailureFacts,
): PublicFailure {
  const diagnosticID = crypto.randomUUID();
  try {
    diagnostic(diagnosticID, cause);
  } catch { /* Diagnostics do not replace failure facts. */ }
  return { code: "action.local", retry: "new-intent", diagnosticID, facts };
}

/** Captured failure facts win; later surface context only fills missing facts. */
export function contextualFailure(
  failure: PublicFailure,
  context?: FailureFacts,
): PublicFailure {
  if (!context) return failure;
  const target = { ...context.target, ...failure.facts?.target };
  const label = failure.facts?.target?.label || context.target?.label;
  return {
    ...failure,
    facts: {
      ...context,
      ...failure.facts,
      target: { ...target, ...(label ? { label } : {}) },
    },
  };
}

/** One entry for definite failures and local exceptions; release is silent. */
export function failureFeedback(
  cause: unknown,
  presenter: FailurePresenter,
  diagnostic: (id: string, cause: unknown) => void = () => {},
  context?: FailureFacts,
): Feedback | undefined {
  if (cause instanceof RequestReleased) return undefined;
  if (cause instanceof FeedbackFailure) return cause.feedback;
  return presenter.present(
    cause instanceof RequestFailure
      ? contextualFailure(cause.failure, context)
      : localFailure(cause, diagnostic, context),
  );
}
