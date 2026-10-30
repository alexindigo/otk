// SPDX-License-Identifier: LGPL-3.0-only
import {
  failureFeedback,
  FailurePresenter,
  type Feedback,
  type FeedbackOwner,
} from "./failures.ts";
import type { RequestMetadataRegistry } from "@otk/protocol";
import type { RequestTracker } from "./requests.ts";

/** Shipped failure vocabulary. The reusable presenter itself has no feature list. */
export function createFailurePresenter(): FailurePresenter {
  const presenter = new FailurePresenter();
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

/** Safe bridge for existing text-only resource ports; never reads exception prose. */
export function failureText(cause: unknown): string {
  return actionFeedback(cause)?.text ?? "";
}
export function actionFeedback(cause: unknown): Feedback | undefined {
  return failureFeedback(
    cause,
    shipped,
    (id, error) => console.error("Action diagnostic", id, error),
  );
}
export function presentFailure(
  failure: import("@otk/protocol").PublicFailure,
): Feedback {
  return shipped.present(failure);
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
        return {
          ...shipped.present(state.error),
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
