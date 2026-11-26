// SPDX-License-Identifier: LGPL-3.0-only
import "./SessionError.css" with { type: "text" };
import { createMemo, Show } from "solid-js";
import { sessionErrorObservation, type SessionErrorState } from "@otk/protocol";
import { placeFailure, sessionFailure } from "@otk/client";
import FeedbackStatus from "./FeedbackStatus.tsx";

export default function SessionError(
  props: {
    state?: SessionErrorState;
    error?: string;
    operationKey?: string;
    diagnosticID?: string;
    /** The composer's feedback in this view; it may hold the view's pointer. */
    composer?: import("@otk/client").Feedback;
    target?: import("@otk/protocol").FailureTarget;
    hasRecord?(messageID: string): boolean;
    onReveal?(messageID: string): void;
  },
) {
  const feedback = createMemo(() => {
    const observation = props.state && sessionErrorObservation(props.state);
    const sameFailure = props.diagnosticID &&
      observation?.failure?.diagnosticID === props.diagnosticID;
    const sameRequest = props.operationKey && observation?.source === "http" &&
      observation.requestID === props.operationKey;
    if (sameFailure || sameRequest) return;
    const failure = sessionFailure(observation, props.error, {
      actionLabel: "Running session",
      target: props.target,
    });
    return failure
      ? placeFailure(
        failure,
        { surface: "session", view: props.target, hasRecord: props.hasRecord },
        props.composer,
      )
      : undefined;
  });
  return (
    <Show when={feedback()}>
      <section
        class="otk-session-error"
        role={feedback()?.kind === "error" ? "alert" : "status"}
        data-error-revision={props.state?.revision}
      >
        <FeedbackStatus feedback={feedback()} onReveal={props.onReveal} />
      </section>
    </Show>
  );
}
