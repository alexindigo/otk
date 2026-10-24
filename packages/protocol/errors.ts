// SPDX-License-Identifier: LGPL-3.0-only
/** Nonempty feedback for an arbitrary thrown value. Failure reporting must not
 * itself throw, including for circular objects or hostile conversion hooks. */
export function errorMessage(value: unknown): string {
  try {
    if (typeof value === "string") return value || "Unknown error";
    if (value === null || value === undefined) return "Unknown error";
    if (typeof value === "object" && "message" in value) {
      const message = value.message;
      if (typeof message === "string" && message) return message;
    }
    const encoded = JSON.stringify(value);
    if (encoded && encoded !== "{}") return encoded;
    const text = String(value);
    return text && text !== "[object Object]" ? text : "Unknown error";
  } catch {
    return "Unknown error";
  }
}

/** Preserve Error identity, stack and feature-owned codes at Error-only ports. */
export function normalizeError(value: unknown): Error {
  return value instanceof Error
    ? value
    : new Error(errorMessage(value), { cause: value });
}

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
