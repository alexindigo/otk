// SPDX-License-Identifier: LGPL-3.0-only
import type { SidecarState } from "@otk/client";

export type ConnectionInput = Pick<
  SidecarState,
  "label" | "status" | "harness" | "error"
>;
export const CONNECTION_STATES = {
  connected: { label: "Connected", shape: "✓" },
  connecting: { label: "Connecting", shape: "◌" },
  reconnecting: { label: "Reconnecting", shape: "↻" },
  disconnected: { label: "Disconnected", shape: "○" },
  error: { label: "Connection error", shape: "×" },
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
