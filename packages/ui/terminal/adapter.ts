// SPDX-License-Identifier: LGPL-3.0-only
import type { TerminalMeta, TerminalSink } from "@otk/client";
import type {
  GhosttyTerminalSurface,
  GhosttyTerminalSurfaceOptions,
} from "./ghostty/surface.ts";

type ReplaySurface = Pick<
  GhosttyTerminalSurface,
  "setSharedGrid" | "resetAndWrite" | "write"
>;

/** The only bridge between the client sink and the vendored surface API. */
export function terminalSink(
  surface: ReplaySurface,
  meta: (change: TerminalMeta) => void,
): TerminalSink {
  return {
    reset(cols, rows, checkpoint) {
      surface.setSharedGrid({ cols, rows });
      surface.resetAndWrite(checkpoint);
    },
    resize: (cols, rows) => surface.setSharedGrid({ cols, rows }),
    write: (bytes) => surface.write(bytes),
    meta,
  };
}

/** Only surface user gestures reach the attachment, never the core's writer. */
export function terminalInput(
  input: (bytes: Uint8Array) => void,
): GhosttyTerminalSurfaceOptions["onData"] {
  const encoder = new TextEncoder();
  return (text) => input(encoder.encode(text));
}
