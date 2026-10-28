// SPDX-License-Identifier: LGPL-3.0-only
import {
  type ClockedContent,
  type ContentClock,
  type ContentOp,
  isAttentionOp,
  type MessagePolicy,
} from "@otk/protocol";
interface Capture {
  events: ClockedContent[];
  bytes: number;
  error?: string;
}
interface Session {
  clock: ContentClock;
  captures: Set<Capture>;
}
/** Bounded event-aligned capture only: no native reader, bodies cache or timers. */
export class ContentReplay {
  #sessions = new Map<string, Session>();
  constructor(
    readonly options: Pick<MessagePolicy, "replayops" | "replaybytes"> & {
      nonce(): string;
      emit(session: string, event: ContentOp, clock?: ContentClock): void;
    },
  ) {}
  #session(id: string): Session {
    let session = this.#sessions.get(id);
    if (!session) {
      session = {
        clock: { epoch: this.options.nonce(), seq: 0 },
        captures: new Set(),
      };
      this.#sessions.set(id, session);
    }
    return session;
  }
  clock(id: string): ContentClock {
    return { ...this.#session(id).clock };
  }
  publish(id: string, event: ContentOp): ContentClock {
    if (isAttentionOp(event)) {
      this.options.emit(id, event);
      return this.clock(id);
    }
    const session = this.#session(id);
    const clock = session.clock = {
      epoch: session.clock.epoch,
      seq: session.clock.seq + 1,
    };
    const frame = { clock, event };
    if (session.captures.size) {
      const bytes = new TextEncoder().encode(JSON.stringify(frame)).byteLength;
      for (const capture of session.captures) {
        if (
          capture.events.length >= this.options.replayops ||
          capture.bytes + bytes > this.options.replaybytes
        ) {
          capture.error = "capture-overflow";
          capture.events = [];
          capture.bytes = 0;
          session.captures.delete(capture);
        } else {
          capture.events.push(frame);
          capture.bytes += bytes;
        }
      }
    }
    this.options.emit(id, event, clock);
    return { ...clock };
  }
  capture(id: string): {
    readonly from: ContentClock;
    seal(): { clock: ContentClock; events: ClockedContent[] };
    release(): void;
  } {
    const session = this.#session(id), from = { ...session.clock };
    const capture: Capture = { events: [], bytes: 0 };
    session.captures.add(capture);
    let released = false;
    return {
      from,
      seal: () => {
        if (capture.error) throw new Error(capture.error);
        if (released || this.#sessions.get(id) !== session) {
          throw new Error("capture-stale");
        }
        const events = capture.events;
        session.captures.delete(capture);
        capture.events = [];
        capture.bytes = 0;
        released = true;
        return { clock: { ...session.clock }, events };
      },
      release: () => {
        released = true;
        session.captures.delete(capture);
        capture.events = [];
        capture.bytes = 0;
      },
    };
  }
  reset(id?: string): void {
    for (const [key, session] of this.#sessions) {
      if (id !== undefined && key !== id) continue;
      for (const capture of session.captures) {
        capture.error = "capture-stale";
        capture.events = [];
        capture.bytes = 0;
      }
      session.captures.clear();
      this.#sessions.delete(key);
    }
  }
  release(id: string): void {
    this.reset(id);
  }
}
