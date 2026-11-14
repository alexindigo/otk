// SPDX-License-Identifier: LGPL-3.0-only
import "./SessionError.css" with { type: "text" };
import { createMemo, Show } from "solid-js";
import { sessionErrorObservation, type SessionErrorState } from "@otk/protocol";
import { presentFailure, sessionFailure } from "@otk/client";
import FailureContent from "./FailureContent.tsx";

export default function SessionError(
  props: {
    state?: SessionErrorState;
    error?: string;
    operationKey?: string;
    diagnosticID?: string;
    target?: import("@otk/protocol").FailureTarget;
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
      action: "Running session",
      target: props.target,
    });
    return failure ? presentFailure(failure) : undefined;
  });
  return (
    <Show when={feedback()}>
      <section
        class="otk-session-error"
        role={feedback()?.kind === "error" ? "alert" : "status"}
        data-error-revision={props.state?.revision}
      >
        <p
          class={["otk-session-error-message", {
            "otk-error": feedback()?.kind === "error",
          }]}
        >
          {feedback()?.failure
            ? <FailureContent failure={feedback()!.failure!} />
            : feedback()?.text}
        </p>
      </section>
    </Show>
  );
}
