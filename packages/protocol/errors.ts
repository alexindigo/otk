// SPDX-License-Identifier: LGPL-3.0-only
export interface ErrorObservation {
  id: string;
  source: "http" | "event";
  message: string;
  kind?: string;
  ref?: string;
  status?: number;
  requestID?: string;
  operation?: "shell" | "command";
  eventID?: string;
  cleared?: boolean;
}
export interface SessionErrorState {
  revision: number;
  currentRequestID?: string;
  observations: ErrorObservation[];
}
export function sessionErrorMessage(
  state: SessionErrorState,
): string | undefined {
  const active = state.observations.filter((item) => !item.cleared);
  const native = active.find((item) => item.source === "event");
  const current = active.find((item) =>
    item.source === "http" && item.requestID === state.currentRequestID
  );
  return native?.message || current?.message ||
    (active.length ? "An earlier request failed." : undefined);
}
