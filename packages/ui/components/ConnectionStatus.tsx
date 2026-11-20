// SPDX-License-Identifier: LGPL-3.0-only
import { Show } from "solid-js";
import {
  connectionFeedback,
  type ConnectionInput,
} from "./connection-light.ts";
import FeedbackStatus from "./FeedbackStatus.tsx";

export default function ConnectionStatus(
  props: {
    connection: ConnectionInput;
    compact?: boolean;
    onSettings?(): void;
  },
) {
  return (
    <Show when={connectionFeedback(props.connection)}>
      {(feedback) => (
        <FeedbackStatus
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
      )}
    </Show>
  );
}
