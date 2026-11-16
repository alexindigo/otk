// SPDX-License-Identifier: LGPL-3.0-only
import {
  contextualFailure,
  failureFeedback,
  type FailurePlacement,
  type FailurePresentation,
  FailurePresenter,
  type Feedback,
  type FeedbackOwner,
  GENERIC_FAILURE_REASON,
} from "./failures.ts";
import type {
  FailureFacts,
  FailureTarget,
  PublicFailure,
  RequestMetadataRegistry,
} from "@otk/protocol";
import {
  createRequestMetadata,
  MAX_SESSION_TITLE,
  MAX_UPLOAD_BYTES,
  publicFailureReason,
} from "@otk/protocol";
import { hashFor } from "./session.ts";
import { sessionTitle } from "./session-title.ts";
import { projectHash, projectName } from "./project-navigation.ts";
import type { Note } from "./notifications.ts";
import { localFailure, RequestFailure, RequestReleased } from "./failures.ts";
import type { RequestTracker } from "./requests.ts";
import { bootstrapRequestMetadata } from "./bootstrap-request-metadata.ts";

/** Shipped failure vocabulary. The reusable presenter itself has no feature list. */
export function createFailurePresenter(): FailurePresenter {
  const metadata = createRequestMetadata();
  for (
    const [method, description] of Object.entries(bootstrapRequestMetadata)
  ) {
    metadata.register(method, description);
  }
  const presenter = new FailurePresenter({
    action: (key) => metadata.get(key)?.pending,
    target: (target) => ({
      label: target.sessionID
        ? sessionTitle(target.sessionID, target.label)
        : target.directory
        ? target.label || projectName(target.directory)
        : target.label || "OTK",
      href: target.sessionID
        ? hashFor({
          sidecarId: target.sidecarId ?? "local",
          sessionID: target.sessionID,
        })
        : target.directory
        ? projectHash({
          sidecarId: target.sidecarId ?? "local",
          directory: target.directory,
        })
        : "#/",
    }),
  });
  presenter.register(
    "native.unknown",
    () => ({ kind: "pending", text: "Checking whether this finished" }),
  );
  const contribute = (codes: string[], text: string, field?: string) => {
    for (const code of codes) {
      presenter.register(code, () => ({ kind: "error", text, field }));
    }
  };
  contribute(
    ["credentials", "auth.credentials", "auth.invalid"],
    "Check your username and password",
    "password",
  );
  contribute(
    ["session.busy", "busy"],
    "This session is working. Try again when it finishes",
  );
  contribute(
    ["session.missing", "session.not-found", "session.deleted"],
    "This session is no longer available",
  );
  contribute(
    ["message.missing", "message.not-found"],
    "This message is no longer available",
  );
  contribute(
    ["request.missing", "request.not-found"],
    "This request is no longer available",
  );
  contribute(
    ["attachment", "attachment.unreadable", "attachment.invalid"],
    "An attachment cannot be read. Restore access or remove it before sending",
  );
  contribute(
    ["attachment.upload-size"],
    `Each upload must be ${MAX_UPLOAD_BYTES / 1024 / 1024} MiB or smaller`,
  );
  contribute(
    ["session.title"],
    `Use a session title of 1–${MAX_SESSION_TITLE} characters`,
    "title",
  );
  contribute(
    ["request.conflict"],
    "This action changed while it was pending. Review the current values",
  );
  contribute(
    ["request.expired"],
    "The old result is no longer retained. Review the current state before starting again",
  );
  contribute(
    ["request.capacity"],
    "The server is busy. Try again when pending work finishes",
  );
  return presenter;
}
const shipped = createFailurePresenter();
/** Snapshot the invoking owner's public wording separately from its opaque ID. */
export function commandFailureFacts(
  command: { readonly id?: string; readonly title?: string },
): FailureFacts {
  return {
    ...(command.id ? { action: command.id } : {}),
    ...(command.title?.trim() ? { actionLabel: command.title } : {}),
  };
}
export type FailureValue = Feedback | "";
export function failureValue(
  cause: unknown,
  context?: FailureFacts,
): FailureValue {
  return actionFeedback(cause, context) ?? "";
}
/** A feature-authored validation reason or an already-owned failure value. */
export function errorFeedback(
  value: string | Feedback | undefined,
  context?: FailureFacts,
): Feedback | undefined {
  if (!value) return;
  return typeof value === "string"
    ? shipped.describe({
      code: "action.validation",
      retry: "new-intent",
      diagnosticID: "validation",
      facts: { ...context, reason: value },
    })
    : value;
}
/** Error-only ports carry the original structured failure, not its rendered text. */
export function feedbackError(value: Feedback): RequestFailure {
  return new RequestFailure(
    value.failure?.value ??
      {
        code: "action.local",
        retry: "new-intent",
        diagnosticID: value.diagnosticID ?? crypto.randomUUID(),
      },
  );
}

/** Safe bridge for existing text-only resource ports; never reads exception prose. */
export function failureText(cause: unknown): string {
  return actionFeedback(cause)?.text ?? "";
}
export function actionFeedback(
  cause: unknown,
  context?: FailureFacts,
): Feedback | undefined {
  if (isFeedback(cause)) return cause;
  return failureFeedback(
    cause,
    shipped,
    (id, error) => console.error("Action diagnostic", id, error),
    context,
  );
}
export function isFeedback(value: unknown): value is Feedback {
  return !!value && typeof value === "object" && "kind" in value &&
    "text" in value;
}
/** Notification surfaces borrow the same owner and rule as inline feedback. */
export function failureNote(
  cause: unknown,
  context?: FailureFacts,
): Note | undefined {
  if (cause instanceof RequestReleased) return;
  if (isFeedback(cause) && cause.failure) {
    cause = new RequestFailure(cause.failure.value);
  }
  const failure: PublicFailure = cause instanceof RequestFailure
    ? contextualFailure(cause.failure, context)
    : localFailure(
      cause,
      (id, error) => console.error("Action diagnostic", id, error),
      context,
    );
  const feedback = shipped.present(failure, { surface: "notification" });
  const target = failure.facts?.target;
  return {
    id: `failure/${feedback.identity}`,
    kind: feedback.kind === "error" ? "error" : "info",
    dismissalKey: `failure/${feedback.failure!.count}`,
    dismissOnView: false,
    title: feedback.text,
    detail: { kind: "failure", value: feedback.failure },
    sessionRef: target?.sessionID
      ? { sidecar: target.sidecarId ?? "local", session: target.sessionID }
      : undefined,
    actions: target?.sessionID
      ? [{
        label: "Open session",
        command: "session.open",
        args: {
          sidecarId: target.sidecarId ?? "local",
          sessionID: target.sessionID,
        },
        default: true,
      }]
      : [],
  };
}
/** The generic notification registry carries opaque feature detail only. */
export function notificationFailure(
  note: Note,
): FailurePresentation | undefined {
  const detail = note.detail as
    | { kind?: string; value?: FailurePresentation }
    | undefined;
  return detail?.kind === "failure" ? detail.value : undefined;
}
export function sessionFailure(
  observation: import("@otk/protocol").ErrorObservation | undefined,
  reason: string | undefined,
  context: FailureFacts,
): PublicFailure | undefined {
  if (!observation && !reason) return;
  const prior = observation?.failure;
  return {
    code: prior?.code ?? "session.failure",
    retry: prior?.retry ?? "none",
    diagnosticID: prior?.diagnosticID ?? observation?.id ??
      `session/${context.target?.sidecarId ?? "local"}/${
        context.target?.sessionID ?? "unknown"
      }`,
    facts: {
      ...context,
      ...prior?.facts,
      target: { ...prior?.facts?.target, ...context.target },
      reason: publicFailureReason(
        prior?.facts?.reason ?? observation?.message ?? reason ??
          GENERIC_FAILURE_REASON,
      ),
      status: prior?.facts?.status ?? observation?.status,
    },
  };
}
export function presentFailure(
  failure: import("@otk/protocol").PublicFailure,
  placement?: FailurePlacement,
): Feedback {
  return shipped.present(failure, placement);
}
/**
 * A session view's composer-origin pointer: its own composer feedback, or the
 * session's retained composer submission failure when another client
 * submitted it. Either spends the view's one pointer before the session
 * indicator.
 */
export function composerPointer(
  failures: readonly PublicFailure[],
  view: FailureTarget | undefined,
  local?: Feedback,
): Feedback | undefined {
  if (local) return local;
  for (const failure of failures) {
    if (failure.facts?.origin !== "composer") continue;
    const shown = shipped.describe(failure, { surface: "feedback", view });
    if (shown.failure?.reference) return shown;
  }
  return local;
}
/** The composer renders this value before it can occupy a view's pointer slot. */
export function sessionComposerFeedback(
  state: import("@otk/protocol").SessionErrorState | undefined,
  view: FailureTarget | undefined,
  local?: Feedback,
): Feedback | undefined {
  return composerPointer(
    (state?.observations ?? []).flatMap((observation) => {
      const target = observation.failure?.facts?.target;
      if (
        target?.sessionID && target.sessionID !== view?.sessionID ||
        target?.sidecarId && target.sidecarId !== (view?.sidecarId ?? "local")
      ) return [];
      const failure = !observation.cleared && observation.failure &&
        sessionFailure(observation, undefined, { target: view });
      return failure ? [failure] : [];
    }),
    view,
    local,
  );
}
export function placeFailure(
  failure: PublicFailure,
  placement: FailurePlacement,
  occupant?: Feedback,
): Feedback | undefined {
  return shipped.place(failure, placement, occupant);
}

/** Target-bound presentation outlives any mounted view and borrows request state. */
export function createRequestFeedback(
  tracker: RequestTracker,
  owner: string,
  metadata: RequestMetadataRegistry,
): FeedbackOwner {
  let local: Feedback | undefined;
  const listeners = new Set<() => void>();
  const notify = () => {
    for (const listener of listeners) listener();
  };
  return {
    current() {
      // A new local/admission rejection is its own outcome, not a replacement
      // result for older work. Keep it visible until its owner clears it.
      if (local) return local;
      const operations = tracker.operations(owner).filter((operation) =>
        metadata.get(operation.state.method)?.kind === "mutation"
      );
      const operation =
        operations.findLast((operation) =>
          metadata.get(operation.state.method)?.presentation !== "bookkeeping"
        ) ?? operations.at(-1);
      if (!operation) return local;
      const state = operation.state;
      const identified = (value: Feedback): Feedback => ({
        ...value,
        identity: state.ref.key,
      });
      if (state.phase === "released" || state.phase === "succeeded") {
        return local;
      }
      if (state.error) {
        const shown = shipped.place(state.error, {
          surface: "feedback",
          view: state.error.facts?.target,
        });
        if (!shown) return;
        return {
          ...shown,
          identity: state.ref.key,
          diagnosticID: state.error.diagnosticID,
        };
      }
      if (state.connection === "authentication-required") {
        return identified({
          kind: "connection",
          text: "Sign in to continue checking this action",
        });
      }
      if (state.connection !== "connected") {
        return identified(shipped.connection());
      }
      if (
        state.progress && state.progress.code !== "working" &&
        state.progress.code !== "queued"
      ) return identified(shipped.progress(state.progress));
      return identified({
        kind: "pending",
        text: metadata.get(state.method)!.pending,
      });
    },
    subscribe(listener) {
      listeners.add(listener);
      const release = tracker.subscribe(listener);
      return () => {
        listeners.delete(listener);
        release();
      };
    },
    fail(cause) {
      local = actionFeedback(cause);
      notify();
    },
    clear() {
      local = undefined;
      notify();
    },
  };
}
