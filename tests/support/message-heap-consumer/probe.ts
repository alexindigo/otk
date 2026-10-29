// SPDX-License-Identifier: LGPL-3.0-only
import type { BodyTarget, TranscriptOwner } from "@otk/client";
import type { ServerFrame } from "@otk/protocol";

type LongTaskObserver = Pick<PerformanceObserver, "takeRecords" | "disconnect">;
function observeLongTasks(
  accept: (entry: PerformanceEntry) => void,
): LongTaskObserver {
  const observer = new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) accept(entry);
  });
  observer.observe({ type: "longtask" });
  return observer;
}

/** Independent consumer observations contain identities/counters/geometry only. */
export function createScaleProbe(o: {
  target: BodyTarget;
  owner(): TranscriptOwner | undefined;
  pane(): HTMLElement | null;
  observeLongTasks?(
    accept: (entry: PerformanceEntry) => void,
  ): LongTaskObserver;
  settle?(run: () => void): void;
}) {
  const data = {
    ranges: [] as {
      at: number;
      first: string;
      last: string;
      before: number;
      after: number;
      count: number;
      older: boolean;
      visible: number;
    }[],
    misses: [] as { at: number; before: number; visible: number }[],
    frames: [] as { at: number; ms: number; historicalReads: number }[],
    longTasks: [] as { at: number; ms: number }[],
    historicalReads: 0,
    streamStart: 0,
    streamEnd: 0,
    completedMessage: "",
    pins: [] as string[],
    pinEvents: [] as { at: number; keys: string[]; acquire: boolean }[],
  };
  Reflect.set(globalThis, "scaleMeasurements", data);
  let reserve = false, streaming = false, reducing = false;
  let animation: number | undefined;
  let range: { first: string; last: string } | undefined;
  let observer: LongTaskObserver | undefined;
  const installed = new WeakSet<TranscriptOwner>();
  const pinned = new Map<string, number>();
  let pending: { at: number; ms: number; before: number } | undefined;
  const finish = () => {
    if (!pending) return;
    const value = pending;
    pending = undefined;
    reducing = false;
    data.frames.push({
      at: value.at,
      ms: value.ms,
      historicalReads: data.historicalReads - value.before,
    });
  };
  const sample = () => {
    if (!reserve) return;
    const state = o.owner()?.state, pane = o.pane();
    if (state && range && pane) {
      const first = state.messageIDs.indexOf(range.first),
        last = state.messageIDs.indexOf(range.last);
      const box = pane.getBoundingClientRect();
      const visible =
        [...pane.querySelectorAll(".otk-text")].filter((element) => {
          const rect = element.getBoundingClientRect();
          return rect.width > 0 && rect.height > 0 && rect.bottom > box.top &&
            rect.top < box.bottom;
        }).length;
      const row = {
        at: performance.now(),
        first: range.first,
        last: range.last,
        before: first,
        after: state.messageIDs.length - 1 - last,
        count: state.messageIDs.length,
        older: state.olderCursor !== null,
        visible,
      };
      data.ranges.push(row);
      if (!visible || first < 0 || row.older && first < 10) {
        data.misses.push({ at: row.at, before: first, visible });
      }
    }
    animation = requestAnimationFrame(sample);
  };
  return {
    data,
    install(owner: TranscriptOwner) {
      if (installed.has(owner)) return;
      installed.add(owner);
      const viewport = owner.viewport.bind(owner);
      owner.viewport = (value) => {
        viewport(value);
        range = value;
      };
      const pin = owner.pin.bind(owner);
      owner.pin = (keys) => {
        const release = pin(keys);
        for (const key of keys) pinned.set(key, (pinned.get(key) ?? 0) + 1);
        data.pins = [...pinned.keys()];
        data.pinEvents.push({
          at: performance.now(),
          keys: [...keys],
          acquire: true,
        });
        let live = true;
        return () => {
          if (!live) return;
          live = false;
          release();
          for (const key of keys) {
            const count = (pinned.get(key) ?? 1) - 1;
            if (count) pinned.set(key, count);
            else pinned.delete(key);
          }
          data.pins = [...pinned.keys()];
          data.pinEvents.push({
            at: performance.now(),
            keys: [...keys],
            acquire: false,
          });
        };
      };
    },
    receive(frame: ServerFrame, run: () => void) {
      // Include the previous frame's deferred binding work, without attributing
      // unrelated incoming metadata work to an ordinary text update.
      finish();
      if (
        streaming && frame.t === "content" &&
        frame.sessionID === o.target.sessionID &&
        frame.event.op === "message.upsert" &&
        frame.event.message.role === "assistant" &&
        frame.event.message.time.completed !== undefined
      ) data.completedMessage = frame.event.message.id;
      const measured = streaming && frame.t === "content" &&
        frame.sessionID === o.target.sessionID &&
        frame.event.op === "part.blocks";
      if (!measured) {
        run();
        return;
      }
      const before = data.historicalReads, at = performance.now();
      reducing = true;
      try {
        run();
      } finally {
        const value = pending = { at, ms: performance.now() - at, before };
        const settle = () => {
          if (pending === value) finish();
        };
        if (o.settle) o.settle(settle);
        else requestAnimationFrame(settle);
      }
    },
    armReserve() {
      if (reserve) return;
      data.ranges = [];
      data.misses = [];
      reserve = true;
      animation = requestAnimationFrame(sample);
    },
    armStream() {
      const owner = o.owner();
      if (!owner) {
        throw new Error("Acquire the transcript before measuring updates");
      }
      const messages = owner.state.messagesByID;
      for (const id of Object.keys(messages)) {
        let message = messages[id];
        Object.defineProperty(messages, id, {
          configurable: true,
          enumerable: true,
          get() {
            if (reducing) data.historicalReads++;
            return message;
          },
          set(value) {
            message = value;
          },
        });
        for (const key of Object.keys(message)) {
          const descriptor = Object.getOwnPropertyDescriptor(message, key)!;
          if (!("value" in descriptor) || !descriptor.configurable) continue;
          let value = descriptor.value;
          Object.defineProperty(message, key, {
            configurable: true,
            enumerable: descriptor.enumerable,
            get() {
              if (reducing) data.historicalReads++;
              return value;
            },
            ...(descriptor.writable
              ? {
                set(next: unknown) {
                  value = next;
                },
              }
              : {}),
          });
        }
      }
      data.frames = [];
      data.historicalReads = 0;
      data.longTasks = [];
      data.streamStart = performance.now();
      data.completedMessage = "";
      streaming = true;
      observer = (o.observeLongTasks ?? observeLongTasks)((entry) =>
        data.longTasks.push({ at: entry.startTime, ms: entry.duration })
      );
    },
    stop() {
      finish();
      reserve = false;
      streaming = false;
      data.streamEnd = performance.now();
      if (animation !== undefined) cancelAnimationFrame(animation);
      for (const entry of observer?.takeRecords() ?? []) {
        data.longTasks.push({ at: entry.startTime, ms: entry.duration });
      }
      observer?.disconnect();
      observer = undefined;
    },
  };
}
