// SPDX-License-Identifier: LGPL-3.0-only
import "./SessionError.css" with { type: "text" };
import { For, Show } from "solid-js";
import { sessionErrorMessage, type SessionErrorState } from "@otk/protocol";

export default function SessionError(
  props: { state?: SessionErrorState; error?: string },
) {
  const message = () =>
    props.state ? sessionErrorMessage(props.state) : props.error;
  return (
    <Show when={message()}>
      <section
        class="otk-session-error"
        role="alert"
        data-error-revision={props.state?.revision}
      >
        <p class="otk-error otk-session-error-message">{message()}</p>
        <Show when={props.state?.observations.length}>
          <details class="otk-session-error-details">
            <summary>
              Failure details · observed state {props.state?.revision}
            </summary>
            <ul>
              <For
                each={props.state?.observations || []}
                keyed={(item) => item.id}
              >
                {(item) => (
                  <li class="otk-error-observation" data-source={item().source}>
                    <p class="otk-error-observation-origin">
                      <span>
                        {item().source === "event"
                          ? "Native session observation"
                          : `${item().operation || "HTTP"} request${
                            item().requestID === props.state?.currentRequestID
                              ? ""
                              : " (earlier)"
                          }`}
                      </span>
                      <Show when={item().status}>
                        <span>HTTP {item().status}</span>
                      </Show>
                      <Show when={item().kind}>
                        <span>{item().kind}</span>
                      </Show>
                    </p>
                    <p class="otk-error-observation-message">
                      {item().message}
                    </p>
                    <Show when={item().cleared}>
                      <p>Observed before a later native busy state.</p>
                    </Show>
                    <Show when={item().ref}>
                      <p>Reference: {item().ref}</p>
                    </Show>
                    <Show when={item().requestID}>
                      <p>Local request: {item().requestID}</p>
                    </Show>
                    <Show when={item().eventID}>
                      <p>Native event: {item().eventID}</p>
                    </Show>
                  </li>
                )}
              </For>
            </ul>
          </details>
        </Show>
      </section>
    </Show>
  );
}
