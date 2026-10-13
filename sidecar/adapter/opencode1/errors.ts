// SPDX-License-Identifier: LGPL-3.0-only
import type {
  ErrorObservation,
  SessionErrorState,
} from "../../../protocol/errors.ts";

export interface ErrorRequest {
  id: string;
  sessionID: string;
  operation: "shell" | "command";
}
type Detail = Pick<ErrorObservation, "message" | "kind" | "ref" | "status">;

// Owns accepted observations and actual local HTTP lifetimes, not native outcomes.
export class SessionErrors {
  #states = new Map<string, SessionErrorState>();
  #requests = new Set<ErrorRequest>();
  #removed = new Set<string>();
  #revision = 0;
  #requestID = 0;
  constructor(
    readonly publish: (sessionID: string, state: SessionErrorState) => void,
  ) {}
  register(sessionID: string): void {
    this.#removed.delete(sessionID);
  }
  snapshot(sessionID: string): SessionErrorState {
    return structuredClone(
      this.#states.get(sessionID) || { revision: 0, observations: [] },
    );
  }
  #update(
    sessionID: string,
    observations: ErrorObservation[],
    currentRequestID = this.#states.get(sessionID)?.currentRequestID,
  ): void {
    const state: SessionErrorState = {
      revision: ++this.#revision,
      ...(currentRequestID ? { currentRequestID } : {}),
      observations,
    };
    this.#states.set(sessionID, state);
    this.publish(sessionID, this.snapshot(sessionID));
  }
  begin(sessionID: string, operation: ErrorRequest["operation"]): ErrorRequest {
    this.register(sessionID);
    const request = {
      id: `request-${++this.#requestID}`,
      sessionID,
      operation,
    };
    this.#requests.add(request);
    this.#update(sessionID, [], request.id);
    return request;
  }
  settled(request: ErrorRequest): void {
    this.#requests.delete(request);
  }
  http(request: ErrorRequest, detail: Detail): void {
    if (
      !this.#requests.delete(request) || this.#removed.has(request.sessionID)
    ) return;
    const current = this.#states.get(request.sessionID);
    this.#update(request.sessionID, [
      ...(current?.observations || []),
      {
        id: request.id,
        source: "http",
        requestID: request.id,
        operation: request.operation,
        ...detail,
      },
    ]);
  }
  native(sessionID: string, detail: Detail, eventID?: string): void {
    if (this.#removed.has(sessionID)) return;
    const current = this.#states.get(sessionID);
    this.#update(sessionID, [
      ...(current?.observations || []).filter((item) =>
        item.source !== "event"
      ),
      {
        id: `observation-${this.#revision + 1}`,
        source: "event",
        ...detail,
        ...(eventID ? { eventID } : {}),
      },
    ]);
  }
  clear(sessionID: string): void {
    if (!this.#removed.has(sessionID)) {
      // Busy clears the current failure, not an independent HTTP diagnostic's
      // provenance. Its arrival is not a request correlation or terminal fence.
      this.#update(
        sessionID,
        (this.#states.get(sessionID)?.observations || [])
          .filter((item) => item.source === "http")
          .map((item) => ({ ...item, cleared: true })),
      );
    }
  }
  #closeRequests(sessionID: string): void {
    for (const request of this.#requests) {
      if (request.sessionID === sessionID) this.#requests.delete(request);
    }
  }
  cancel(sessionID: string): void {
    this.#closeRequests(sessionID);
    if (!this.#removed.has(sessionID)) {
      // Local HTTP cancellation has no authority to clear a native observation
      // such as MessageAbortedError already emitted by the harness.
      this.#update(
        sessionID,
        (this.#states.get(sessionID)?.observations || [])
          .filter((item) => item.source === "event"),
      );
    }
  }
  remove(sessionID: string): void {
    this.#closeRequests(sessionID);
    if (!this.#removed.has(sessionID)) this.#update(sessionID, []);
    this.#states.delete(sessionID);
    this.#removed.add(sessionID);
  }
  reset(): void {
    this.#requests.clear();
    for (const sessionID of this.#states.keys()) this.#update(sessionID, []);
    this.#removed.clear();
  }
}
