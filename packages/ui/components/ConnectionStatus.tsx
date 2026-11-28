// SPDX-License-Identifier: LGPL-3.0-only
import { Show } from "solid-js";
import { SERVER_RELOAD } from "@otk/client";
import { useCommandPorts } from "../keyboard/context.tsx";
import {
  connectionFeedback,
  type ConnectionInput,
} from "./connection-light.ts";
import FeedbackStatus from "./FeedbackStatus.tsx";
import ChromeMeta from "./ChromeMeta.tsx";
import "./ConnectionStatus.css" with { type: "text" };

export default function ConnectionStatus(
  props: {
    connection: ConnectionInput & { id?: string };
    compact?: boolean;
    onSettings?(): void;
    subgrid?: boolean;
    unlabelled?: boolean;
  },
) {
  const { commands } = useCommandPorts();
  const feedback = () => {
    const sidecarId = props.connection.id;
    return connectionFeedback(
      props.connection,
      sidecarId && commands.has(SERVER_RELOAD)
        ? () => void commands.run(SERVER_RELOAD, { sidecarId })
        : undefined,
    );
  };
  const classes = () =>
    [
      "otk-connection-status",
      props.subgrid ? "is-subgrid" : "",
      props.unlabelled ? "is-unlabelled" : "",
    ].filter(Boolean).join(" ");
  return (
    <Show when={feedback()}>
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
