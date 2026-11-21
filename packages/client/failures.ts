// SPDX-License-Identifier: LGPL-3.0-only
import { randomID } from "@otk/protocol";
import type {
  FailureFacts,
  FailureTarget,
  PublicFailure,
  RequestProgress,
} from "@otk/protocol";
interface FailureContent {
  value: PublicFailure;
  action: string;
  heading: string;
  target: { label: string; href?: string };
  reason: string;
  /** Specific next step supplied by the action/cause owner, absent otherwise. */
  recovery?: string;
  count: number;
  occurrences: readonly string[];
  /** No feature-authored reason: Details carry the diagnostic ID instead. */
  generic?: boolean;
  /** A retained record owns the facts; another surface only points to it. */
  reference?: { messageID: string; label: string };
}
/** Outcome and visual signal cannot disagree, even for independent consumers. */
export type FailurePresentation =
  & FailureContent
  & (
    | { kind: "pending"; tone: "neutral" }
    | { kind: "info"; tone: "info" }
    | { kind: "error"; tone: "error" }
  );
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
/** Placement is local to a surface/view, never a reason to discard a failure. */
export type FailurePlacement = "record" | {
  surface: "feedback" | "session" | "notification" | "record";
  view?: FailureTarget;
};
function sameView(a?: FailureTarget, b?: FailureTarget): boolean {
  return !!a?.sessionID && a.sessionID === b?.sessionID &&
    (a.sidecarId ?? "local") === (b.sidecarId ?? "local");
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
      action?(key: string): string | undefined;
      target?(target: FailureTarget): { label: string; href?: string };
    } = {},
  ) {}
  register(code: string, present: (failure: PublicFailure) => Feedback): void {
    if (this.#contributions.has(code)) {
      throw new Error("Duplicate failure presentation");
    }
    this.#contributions.set(code, present);
  }
  #present(
    failure: PublicFailure,
    placement: FailurePlacement = {
      surface: "feedback",
      view: failure.facts?.target,
    },
  ): Feedback {
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
            ...(sourceFacts.record
              ? { record: { ...sourceFacts.record } }
              : {}),
          },
        }
        : {}),
    };
    const enrichment = this.#contributions.get(failure.code)?.(failure);
    const facts = failure.facts ?? {};
    const retained = placement === "record" || placement.surface === "record";
    const reference = !retained &&
      placement.surface !== "notification" && placement.view?.sessionID &&
      placement.view.sessionID === facts.target?.sessionID &&
      (placement.view.sidecarId ?? "local") ===
        (facts.target?.sidecarId ?? "local");
    const action = (facts.action && this.context.action?.(facts.action)) ||
      facts.actionLabel || "The requested action";
    const target =
      placement !== "record" && placement.surface !== "notification" &&
        sameView(facts.target, placement.view)
        ? { label: "" }
        : this.context.target?.(facts.target ?? {}) ??
          { label: facts.target?.label ?? "OTK" };
    const known = [facts.reason, enrichment?.text].find((text) => text?.trim());
    const reason = known ?? GENERIC_FAILURE_REASON;
    const status = facts.status === undefined ? "" : ` (HTTP ${facts.status})`;
    const pending = facts.outcome === "unknown" ||
      facts.outcome === "unavailable" || enrichment?.kind === "pending";
    const informational = !pending && enrichment?.kind === "info";
    const heading = pending
      ? `Checking whether ${action.charAt(0).toLowerCase()}${
        action.slice(1)
      } finished`
      : informational || /(?:^|\s)failed[.!]?$/i.test(action)
      ? action
      : `${action} failed`;
    // Retry policy classifies execution, not advice. Only an owner that knows
    // this action and cause can supply a useful next step.
    const recovery = facts.recovery?.trim() || undefined;
    const presentation: FailurePresentation = {
      ...(pending
        ? { kind: "pending", tone: "neutral" } as const
        : informational
        ? { kind: "info", tone: "info" } as const
        : { kind: "error", tone: "error" } as const),
      value: failure,
      action,
      heading,
      target,
      reason: reason + status,
      recovery,
      count: 1,
      occurrences: [failure.diagnosticID],
      ...(known ? {} : { generic: true }),
      ...(facts.record && reference
        ? {
          reference: {
            messageID: facts.record.messageID,
            label: placement.surface === "session"
              ? "See the session error"
              : facts.record.label ?? "See the error above",
          },
        }
        : {}),
    };
    return {
      ...enrichment,
      kind: pending ? "pending" : informational ? "info" : "error",
      text: presentation.reference?.label ?? [
        informational
          ? presentation.reason
          : `${heading}${
            target.label ? ` for ${target.label}` : ""
          }: ${presentation.reason}`,
        ...recovery ? [recovery] : [],
      ].map((sentence) => /[.!?]$/.test(sentence) ? sentence : `${sentence}.`)
        .join(" "),
      diagnosticID: failure.diagnosticID,
      field: failure.field ?? enrichment?.field,
      failure: presentation,
    };
  }
  /** The only grouping rule. Targets stay separate until decision 41 is settled. */
  groupingKey(failure: PublicFailure): string {
    const shown = this.#present(failure).failure!;
    const target = failure.facts?.target;
    const key = failure.facts?.action;
    // Unknown identities stay distinct even though their public wording is generic.
    const action = key ? this.context.action?.(key) || key : shown.action;
    return JSON.stringify([
      target?.sidecarId ?? "local",
      target?.sessionID ?? target?.directory ?? "OTK",
      action,
      shown.reason,
      shown.recovery,
      failure.retry,
    ]);
  }
  describe(
    failure: PublicFailure,
    placement?: FailurePlacement,
  ): Feedback {
    return this.#present(failure, placement);
  }
  /**
   * A view shows at most one short pointer to its retained failure records.
   * A pointer belongs to its failure's input origin: composer submissions
   * point from the composer, everything else from the session. A composer
   * pointer shown in the same view (`occupant`) takes precedence, so the
   * session indicator waits until no composer pointer is present. Records
   * themselves are never budgeted, and no failures are correlated here.
   */
  place(
    failure: PublicFailure,
    placement: FailurePlacement,
    occupant?: Feedback,
  ): Feedback | undefined {
    const value = this.#present(failure, placement);
    if (value.failure?.reference && placement !== "record") {
      const origin = failure.facts?.origin ?? "session";
      if (
        placement.surface === "session" && origin === "composer" ||
        placement.surface === "feedback" && origin !== "composer"
      ) return;
      const held = occupant?.failure;
      if (
        placement.surface === "session" && held?.reference &&
        held.value.facts?.origin === "composer" &&
        sameView(held.value.facts.target, placement.view)
      ) return;
    }
    return this.present(failure, placement);
  }
  present(
    failure: PublicFailure,
    placement?: FailurePlacement,
  ): Feedback {
    const key = this.groupingKey(failure);
    let group = this.#groups.get(key);
    if (!group) {
      group = { identity: randomID(), occurrences: new Set() };
      this.#groups.set(key, group);
    }
    group.occurrences.add(failure.diagnosticID);
    const value = this.#present(failure, placement);
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
  const diagnosticID = randomID();
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
  const failure = cause instanceof RequestFailure
    ? contextualFailure(cause.failure, context)
    : localFailure(cause, diagnostic, context);
  return presenter.place(failure, {
    surface: "feedback",
    view: context?.target ?? failure.facts?.target,
  });
}
