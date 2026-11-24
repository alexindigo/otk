// SPDX-License-Identifier: LGPL-3.0-only
import {
  type ConnectionInput,
  errorFeedback,
  type Feedback,
} from "@otk/client";

export {
  type ConnectionInput,
  type ConnectionLightState,
  connectionState,
} from "@otk/client";
export const CONNECTION_STATES = {
  updated: { label: "OTK was updated", shape: "retry" },
  connected: { label: "Connected", shape: "check" },
  connecting: { label: "Connecting", shape: "loading" },
  reconnecting: { label: "Reconnecting", shape: "retry" },
  disconnected: { label: "Disconnected", shape: "circle" },
  error: { label: "Connection error", shape: "cross" },
} as const;
export function connectionLabel(connection?: ConnectionInput): string {
  return connection
    ? `${connection.label}: ${connection.status}; agent service ${connection.harness}${
      connection.error ? `; ${connection.error}` : ""
    }`
    : CONNECTION_STATES.disconnected.label;
}
/** Present the connection owner's state, never invent another retry lifetime. */
export function connectionFeedback(
  connection: ConnectionInput,
): Feedback | undefined {
  if (
    connection.status === "client outdated" ||
    connection.status === "protocol mismatch"
  ) {
    return connection.feedback ?? { kind: "info", text: "OTK was updated" };
  }
  if (connection.error) {
    return connection.feedback ?? errorFeedback(connection.error, {
      actionLabel: "Connecting",
      target: { label: connection.label },
    });
  }
  if (connection.status === "reconnecting") {
    return { kind: "info", text: "Reconnecting to OTK..." };
  }
  if (connection.harness === "reconnecting") {
    return { kind: "info", text: "Reconnecting to the agent service..." };
  }
}
