// SPDX-License-Identifier: LGPL-3.0-only
import type { Page } from "@playwright/test";

export interface ScaleFrame {
  socket: number;
  direction: "sent" | "received";
  at: number;
  frame: {
    t: string;
    method: string;
    params?: {
      directory?: string;
      sessionID?: string;
      before?: string;
      kinds?: string[];
      intent?: string;
    };
  };
}
/** Socket identity is owned by Playwright, not inferred from application globals. */
export function scaleWire(page: Page) {
  const frames: ScaleFrame[] = [];
  let next = 0;
  page.on("websocket", (socket) => {
    const id = ++next;
    const record = (
      direction: "sent" | "received",
      payload: string | Buffer,
    ) => {
      frames.push({
        socket: id,
        direction,
        at: performance.now(),
        frame: JSON.parse(payload.toString()),
      });
    };
    socket.on("framesent", ({ payload }) => record("sent", payload));
    socket.on("framereceived", ({ payload }) => record("received", payload));
  });
  return frames;
}
export function scaleGenerations(frames: ScaleFrame[]) {
  const sockets = new Map<
    number,
    {
      hellos: number;
      welcomes: number;
      requests: {
        method: string;
        directory: unknown;
        kinds?: string[];
        intent?: string;
      }[];
    }
  >();
  for (const event of frames) {
    let generation = sockets.get(event.socket);
    if (!generation) {
      generation = { hellos: 0, welcomes: 0, requests: [] };
      sockets.set(event.socket, generation);
    }
    const frame = event.frame;
    if (event.direction === "sent" && frame.t === "hello") generation.hellos++;
    if (event.direction === "received" && frame.t === "welcome") {
      generation.welcomes++;
    }
    if (
      event.direction === "sent" && frame.t === "request" &&
      /^(catalogs\.|agents\.list|models\.list|commands\.list|resources\.list|find\.files|frecency\.list)/
        .test(frame.method)
    ) {
      generation.requests.push({
        method: frame.method,
        directory: frame.params?.directory,
        kinds: frame.params?.kinds,
        intent: frame.params?.intent,
      });
    }
  }
  return [...sockets.values()].filter((g) =>
    g.hellos || g.welcomes || g.requests.length
  );
}
