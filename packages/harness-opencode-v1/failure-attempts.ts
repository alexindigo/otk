// SPDX-License-Identifier: LGPL-3.0-only
/** Deduplicate native reports within one observed turn, never against HTTP. */
export class FailureAttempts {
  #reported = new Map<string, { recordID: string; reason: string }>();
  #events = new Map<string, Map<string, string>>();
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
    const recordID = repeated ? reported.recordID : fallback;
    if (!repeated) this.#reported.set(sessionID, { recordID, reason });
    if (eventID) {
      events.set(eventID, recordID);
      this.#events.set(sessionID, events);
    }
    return recordID;
  }
  retire(sessionID: string): void {
    this.#reported.delete(sessionID);
  }
  remove(sessionID: string): void {
    this.retire(sessionID);
    this.#events.delete(sessionID);
  }
  clear(): void {
    this.#reported.clear();
    this.#events.clear();
  }
}
