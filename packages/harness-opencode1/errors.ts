// SPDX-License-Identifier: LGPL-3.0-only
import type { ErrorObservation, SessionErrorState } from "@otk/protocol";

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
    readonly retained: (sessionID: string) => boolean = () => false,
    readonly baseline: (sessionID: string) => SessionErrorState | undefined =
      () => undefined,
  ) {}
  register(sessionID: string): void {
    this.#removed.delete(sessionID);
  }
  snapshot(sessionID: string): SessionErrorState {
    return structuredClone(
      this.#states.get(sessionID) || this.baseline(sessionID) ||
        { revision: 0, observations: [] },
    );
  }
  #update(
    sessionID: string,
    observations: ErrorObservation[],
    currentRequestID = this.#states.get(sessionID)?.currentRequestID,
  ): void {
    const active = [...this.#requests].some((request) =>
      request.sessionID === sessionID
    );
    const state: SessionErrorState = {
      revision: ++this.#revision,
      ...(currentRequestID && (observations.length || active)
        ? { currentRequestID }
        : {}),
      observations,
    };
    if (
      observations.length || active ||
      (this.retained(sessionID) && !this.baseline(sessionID))
    ) {
      this.#states.set(sessionID, state);
    } else this.#states.delete(sessionID);
    this.publish(sessionID, structuredClone(state));
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
    const state = this.#states.get(request.sessionID);
    if (
      state && !state.observations.length &&
      ![...this.#requests].some((item) => item.sessionID === request.sessionID)
    ) {
      this.#update(request.sessionID, []);
    }
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
    if (this.#states.has(sessionID)) this.#update(sessionID, []);
    this.#states.delete(sessionID);
    this.#removed.add(sessionID);
  }
  reset(): void {
    this.#requests.clear();
    for (const sessionID of [...this.#states.keys()]) {
      this.#update(sessionID, [], undefined);
    }
    this.#removed.clear();
  }
  release(sessionID: string): void {
    const state = this.#states.get(sessionID);
    if (
      state && !state.observations.length &&
      ![...this.#requests].some((request) => request.sessionID === sessionID)
    ) this.#states.delete(sessionID);
  }
  reconcile(ids: ReadonlySet<string>): void {
    // A new accepted snapshot is the release barrier for old deletion fences.
    this.#removed.clear();
    for (const [id, state] of this.#states) {
      if ([...this.#requests].some((request) => request.sessionID === id)) {
        continue;
      }
      if (
        (!state.observations.length && this.baseline(id)) ||
        (!ids.has(id) && !this.retained(id))
      ) this.#states.delete(id);
    }
  }
}
