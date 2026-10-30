// SPDX-License-Identifier: LGPL-3.0-only
import "./SessionError.css" with { type: "text" };
import { Show } from "solid-js";
import { sessionErrorObservation, type SessionErrorState } from "@otk/protocol";
import { presentFailure } from "@otk/client";

export default function SessionError(
  props: {
    state?: SessionErrorState;
    error?: string;
    operationKey?: string;
    diagnosticID?: string;
  },
) {
  const feedback = () => {
    const observation = props.state && sessionErrorObservation(props.state);
    const sameFailure = props.diagnosticID &&
      observation?.failure?.diagnosticID === props.diagnosticID;
    const sameRequest = props.operationKey && observation?.source === "http" &&
      observation.requestID === props.operationKey;
    if (sameFailure || sameRequest) return;
    return observation?.failure
      ? presentFailure(observation.failure)
      : observation || props.error
      ? {
        kind: "error",
        text:
          "The agent reported a session failure. Review the conversation before continuing",
      }
      : undefined;
  };
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
          {feedback()?.text}
        </p>
      </section>
    </Show>
  );
}
