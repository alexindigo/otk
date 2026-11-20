// SPDX-License-Identifier: LGPL-3.0-only
import { errorFeedback, type Feedback, type SidecarState } from "@otk/client";

export type ConnectionInput = Pick<
  SidecarState,
  "label" | "status" | "harness" | "error" | "feedback"
>;
export const CONNECTION_STATES = {
  connected: { label: "Connected", shape: "check" },
  connecting: { label: "Connecting", shape: "loading" },
  reconnecting: { label: "Reconnecting", shape: "retry" },
  disconnected: { label: "Disconnected", shape: "circle" },
  error: { label: "Connection error", shape: "cross" },
} as const;
export type ConnectionLightState = keyof typeof CONNECTION_STATES;

/** Both links must be healthy. Session work/attention never enters this owner. */
export function connectionState(
  connection?: ConnectionInput,
): ConnectionLightState {
  if (!connection) return "disconnected";
  if (
    connection.error || connection.status === "login required" ||
    connection.status === "setup required" ||
    connection.status === "protocol mismatch"
  ) return "error";
  if (
    connection.status === "reconnecting" ||
    connection.harness === "reconnecting"
  ) return "reconnecting";
  if (connection.status === "connected" && connection.harness === "connected") {
    return "connected";
  }
  return "connecting";
}
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
