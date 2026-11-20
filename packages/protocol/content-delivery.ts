// SPDX-License-Identifier: LGPL-3.0-only
import type { ContentClock } from "./transcript.ts";

export interface ContentDeliveryReceipt {
  boundary: "native" | "fanout" | "browser";
  sessionID: string;
  operation: string;
  messageID?: string;
  clock?: ContentClock;
  previous?: ContentClock;
  reason?: string;
  state:
    | "emitted"
    | "unsubscribed"
    | "sent"
    | "accepted"
    | "gap"
    | "projection-error";
  recipients?: number;
  at: number;
}
/** Scalar diagnostic witnesses only: never bodies, payloads or another replay. */
export class ContentDeliveryDiagnostics {
  #last = new Map<string, ContentDeliveryReceipt>();
  #accepted = new Map<string, ContentClock>();
  constructor(readonly boundary: ContentDeliveryReceipt["boundary"]) {}
  record(value: Omit<ContentDeliveryReceipt, "boundary" | "at">): void {
    const receipt = {
      ...value,
      ...(value.clock ? { clock: { ...value.clock } } : {}),
      ...(value.previous ? { previous: { ...value.previous } } : {}),
      boundary: this.boundary,
      at: Date.now(),
    };
    this.#last.set(value.sessionID, receipt);
    if (value.state === "accepted" && value.clock) {
      this.#accepted.set(value.sessionID, { ...value.clock });
    }
    if (
      value.operation === "message.upsert" || value.state === "gap" ||
      value.state === "projection-error"
    ) {
      console.debug("OTK content receipt", JSON.stringify(receipt));
    }
  }
  get(
    sessionID: string,
  ): { last?: ContentDeliveryReceipt; accepted?: ContentClock } {
    const last = this.#last.get(sessionID),
      accepted = this.#accepted.get(sessionID);
    return {
      ...(last ? { last: structuredClone(last) } : {}),
      ...(accepted ? { accepted: { ...accepted } } : {}),
    };
  }
  clear(): void {
    this.#last.clear();
    this.#accepted.clear();
  }
}
