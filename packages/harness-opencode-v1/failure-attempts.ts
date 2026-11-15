// SPDX-License-Identifier: LGPL-3.0-only
export interface FailureAttempt {
  readonly sessionID: string;
  readonly id: string;
  readonly recordID: string;
  readonly origin?: import("@otk/protocol").RequestOrigin;
}
/** Pending admission is not report deduplication. A terminal attempt cannot
 * consume a later error merely because it belongs to the same session. */
export class FailureAttempts {
  #pending = new Map<string, FailureAttempt>();
  #reported = new Map<string, { recordID: string; reason: string }>();
  #events = new Map<string, Map<string, string>>();
  origin(sessionID: string): import("@otk/protocol").RequestOrigin | undefined {
    return this.#pending.get(sessionID)?.origin;
  }
  begin(
    sessionID: string,
    id: string,
    origin?: import("@otk/protocol").RequestOrigin,
  ): FailureAttempt {
    this.retire(sessionID);
    const attempt = {
      sessionID,
      id,
      recordID: `request:failure:launch:${id}`,
      origin,
    };
    this.#pending.set(sessionID, attempt);
    return attempt;
  }
  settle(attempt: FailureAttempt): void {
    if (this.#pending.get(attempt.sessionID) === attempt) {
      this.#pending.delete(attempt.sessionID);
    }
  }
  replay(sessionID: string, eventID?: string): boolean {
    return eventID !== undefined &&
      this.#events.get(sessionID)?.has(eventID) === true;
  }
  native(
    sessionID: string,
    reason: string,
    fallback: string,
    eventID?: string,
  ): string {
    const events = this.#events.get(sessionID) ?? new Map<string, string>();
    const replay = eventID && events.get(eventID);
    if (replay) return replay;
    const reported = this.#reported.get(sessionID);
    // Native getModel and promptAsync can report the readable reason and then
    // its enclosing cause. Neither creates another attempt after settlement.
    const repeated = reported && (reason === reported.reason ||
      reported.reason.length > 0 && reason.includes(reported.reason));
    const pending = this.#pending.get(sessionID);
    const recordID = repeated
      ? reported.recordID
      : pending?.recordID ?? fallback;
    if (pending) this.settle(pending);
    if (!repeated) this.#reported.set(sessionID, { recordID, reason });
    if (eventID) {
      events.set(eventID, recordID);
      this.#events.set(sessionID, events);
    }
    return recordID;
  }
  retire(sessionID: string): void {
    this.#pending.delete(sessionID);
    this.#reported.delete(sessionID);
  }
  remove(sessionID: string): void {
    this.retire(sessionID);
    this.#events.delete(sessionID);
  }
  clear(): void {
    this.#pending.clear();
    this.#reported.clear();
    this.#events.clear();
  }
}
