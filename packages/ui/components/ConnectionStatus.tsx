// SPDX-License-Identifier: LGPL-3.0-only
import { Show } from "solid-js";
import {
  connectionFeedback,
  type ConnectionInput,
} from "./connection-light.ts";
import FeedbackStatus from "./FeedbackStatus.tsx";
import ChromeMeta from "./ChromeMeta.tsx";
import "./ConnectionStatus.css" with { type: "text" };

export default function ConnectionStatus(
  props: {
    connection: ConnectionInput;
    compact?: boolean;
    onSettings?(): void;
    subgrid?: boolean;
    unlabelled?: boolean;
  },
) {
  const classes = () =>
    [
      "otk-connection-status",
      props.subgrid ? "is-subgrid" : "",
      props.unlabelled ? "is-unlabelled" : "",
    ].filter(Boolean).join(" ");
  return (
    <Show when={connectionFeedback(props.connection)}>
      {(feedback) => (
        <Show
          when={feedback().failure || feedback().action}
          fallback={
            <ChromeMeta class={classes()} role="status">
              {feedback().text}
            </ChromeMeta>
          }
        >
          <FeedbackStatus
            class={classes()}
            subgrid={props.subgrid && !!feedback().failure}
            compact={props.compact}
            feedback={{
              ...feedback(),
              ...(feedback().failure && props.onSettings
                ? {
                  action: {
                    label: "Server settings",
                    run: () => props.onSettings?.(),
                  },
                }
                : {}),
            }}
          />
        </Show>
      )}
    </Show>
  );
}
