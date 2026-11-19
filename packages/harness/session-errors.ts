// SPDX-License-Identifier: LGPL-3.0-only
import type {
  ErrorObservation,
  PublicFailure,
  SessionErrorState,
} from "@otk/protocol";

export interface ErrorRequest {
  id: string;
  sessionID: string;
  operation: ErrorObservation["operation"];
}
type Detail = Pick<
  ErrorObservation,
  "message" | "kind" | "ref" | "status" | "failure"
>;

// Owns accepted observations and actual local HTTP lifetimes, not native outcomes.
export class SessionErrors {
  #states = new Map<string, SessionErrorState>();
  #requests = new Set<ErrorRequest>();
  #removed = new Set<string>();
  #revision = 0;
  #requestID = 0;
  #history = new Map<
    string,
    {
      sessionID: string;
      run: () => void | Promise<void>;
      failed?: boolean;
      running?: Promise<void>;
    }
  >();
  /** History persistence is recoverable local work, never authority over native input. */
  async retainHistory(
    sessionID: string,
    key: string,
    run: () => void | Promise<void>,
  ): Promise<void> {
    const identity = JSON.stringify([sessionID, key]);
    const job = this.#history.get(identity) ?? { sessionID, run };
    this.#history.set(identity, job);
    await this.#saveHistory(identity, job);
  }
  #saveHistory(
    identity: string,
    job: {
      sessionID: string;
      run: () => void | Promise<void>;
      failed?: boolean;
      running?: Promise<void>;
    },
  ): Promise<void> {
    if (job.running) return job.running;
    return job.running = Promise.resolve().then(job.run).then(() => {
      this.#history.delete(identity);
      if (job.failed) {
        this.#update(
          job.sessionID,
          this.snapshot(job.sessionID).observations.filter((item) =>
            item.id !== `history:${identity}`
          ),
        );
      }
    }).catch((error) => {
      job.failed = true;
      this.#update(job.sessionID, this.snapshot(job.sessionID).observations);
      throw error;
    }).finally(() => {
      job.running = undefined;
    });
  }
  async retryHistory(sessionID?: string): Promise<void> {
    for (const [identity, job] of this.#history) {
      if (!job.failed || sessionID && job.sessionID !== sessionID) continue;
      try {
        await this.#saveHistory(identity, job);
      } catch { /* The failure remains visible with its retryable work. */ }
    }
  }
  constructor(
    readonly publish: (sessionID: string, state: SessionErrorState) => void,
    readonly retained: (sessionID: string) => boolean = () => false,
    readonly baseline: (sessionID: string) => SessionErrorState | undefined =
      () => undefined,
  ) {}
  register(sessionID: string): void {
    this.#removed.delete(sessionID);
  }
  /** All failure projections borrow this owner's native-deletion fence. */
  accepts(sessionID: string): boolean {
    return !this.#removed.has(sessionID);
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
    observations = observations.filter((item) =>
      !item.id.startsWith("history:")
    );
    for (const [identity, job] of this.#history) {
      if (job.sessionID === sessionID && job.failed) {
        observations.push({
          id: `history:${identity}`,
          source: "http",
          message:
            "OTK could not save request history. Reload the session to retry; the request's native state is unchanged.",
        });
      }
    }
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
  begin(
    sessionID: string,
    operation: ErrorRequest["operation"],
    requestID?: string,
  ): ErrorRequest {
    this.register(sessionID);
    const request = {
      id: requestID ?? `request-${++this.#requestID}`,
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
  /** Enrich only the same still-current failure; recovery never recreates a note. */
  enrich(sessionID: string, failure: PublicFailure): void {
    if (this.#removed.has(sessionID) || !failure.facts?.origin) return;
    const current = this.#states.get(sessionID) ?? this.baseline(sessionID);
    let changed = false;
    const observations = current?.observations.map((observation) => {
      if (
        observation.cleared ||
        observation.failure?.diagnosticID !== failure.diagnosticID ||
        observation.failure.facts?.origin
      ) return observation;
      changed = true;
      return {
        ...observation,
        failure: {
          ...observation.failure,
          facts: {
            ...observation.failure.facts,
            origin: failure.facts!.origin,
          },
        },
      };
    });
    if (changed && observations) {
      this.#update(sessionID, observations, current?.currentRequestID);
    }
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
