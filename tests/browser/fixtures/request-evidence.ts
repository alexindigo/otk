// SPDX-License-Identifier: LGPL-3.0-only
import { expect } from "@playwright/test";
import type { ScaleFrame } from "./scale-wire.ts";

export interface ReadPhase {
  name: string;
  start: number;
  end: number;
}
/** A result after release is not completed consumer demand. Socket/window are authority. */
export function requestReads(
  frames: ScaleFrame[],
  phases: ReadPhase[],
  method: string,
  sessions: Set<string>,
) {
  return frames.flatMap((event, index) => {
    const request = event.frame;
    if (
      event.direction !== "sent" || request.t !== "request" ||
      request.method !== method ||
      !sessions.has(request.params?.sessionID ?? "")
    ) return [];
    const same = (other: ScaleFrame, ref: { key: string; window: string }) =>
      other.socket === event.socket && ref.key === request.ref!.key &&
      ref.window === request.ref!.window;
    const result = frames.findIndex((other, n) =>
      n > index && other.direction === "received" &&
      other.frame.t === "request.result" && !!other.frame.ref &&
      same(other, other.frame.ref)
    );
    const released = frames.findIndex((other, n) =>
      n > index && other.direction === "sent" &&
      other.frame.t === "request.release" && other.frame.refs?.some((ref) =>
        same(other, ref)
      )
    );
    const closed = frames.findIndex((other, n) =>
      n > index && other.socket === event.socket &&
      other.frame.t === "socket.closed"
    );
    const phase = phases.find((phase) =>
      index >= phase.start && index < phase.end
    )?.name ?? "outside";
    return [{
      phase,
      socket: event.socket,
      window: request.ref!.window,
      key: request.ref!.key,
      sessionID: request.params!.sessionID!,
      index,
      status: (released >= 0 && (result < 0 || released < result)) ||
          (closed >= 0 && (result < 0 || closed < result))
        ? "cancelled"
        : result < 0
        ? "pending"
        : frames[result].frame.outcome?.ok
        ? "completed"
        : "failed",
      result,
      released,
      closed,
    }];
  });
}
export function assertReadDemand(
  reads: ReturnType<typeof requestReads>,
  phase: string,
  required: string[] = [],
) {
  const selected = reads.filter((read) => read.phase === phase);
  expect(
    selected.filter((read) =>
      read.status === "pending" || read.status === "failed"
    ),
    JSON.stringify(selected),
  ).toEqual([]);
  const completed = selected.filter((read) => read.status === "completed");
  const scopes = completed.map((read) =>
    JSON.stringify([read.socket, read.window, read.sessionID])
  );
  expect(new Set(scopes).size, JSON.stringify(selected)).toBe(scopes.length);
  for (const sessionID of required) {
    expect(
      completed.some((read) => read.sessionID === sessionID),
      JSON.stringify(selected),
    ).toBe(true);
  }
}
