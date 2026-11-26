// SPDX-License-Identifier: LGPL-3.0-only
import type { TerminalMeta, TerminalSink } from "@otk/client";
import {
  GhosttyTerminalSurface,
  type GhosttyTerminalSurfaceOptions,
} from "./ghostty/surface.ts";
import type { ThemeColors } from "../theme/slots.ts";
import type { GhosttyColor, GhosttyTheme } from "./ghostty/core.ts";

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

/** Surface input reaches the attachment, never the core's writer. */
export function terminalInput(
  input: (bytes: Uint8Array, origin: "user" | "program") => void,
): GhosttyTerminalSurfaceOptions["onData"] {
  const encoder = new TextEncoder();
  return (data, origin) =>
    input(typeof data === "string" ? encoder.encode(data) : data, origin);
}

function rgb(hex: string): GhosttyColor {
  return {
    r: parseInt(hex.slice(1, 3), 16),
    g: parseInt(hex.slice(3, 5), 16),
    b: parseInt(hex.slice(5, 7), 16),
  };
}
export function terminalTheme(colors: ThemeColors): GhosttyTheme {
  return {
    background: rgb(colors["bg-side"]),
    foreground: rgb(colors.fg),
    cursor: rgb(colors["accent-text"]),
    selectionBackground: colors.selected,
  };
}
export interface TerminalRenderer {
  sink: TerminalSink;
  visible(value: boolean): void;
  theme(colors: ThemeColors): void;
  focus(): void;
  paste(text: string): void;
  submit(): void;
  erase(count: number): void;
  bracketedPaste(): boolean;
  selection(): string;
  dispose(): void;
}
export async function createTerminalRenderer(
  mount: HTMLElement,
  ports: {
    colors: ThemeColors;
    input(bytes: Uint8Array, origin: "user" | "program"): void;
    resize(cols: number, rows: number): void;
    selection(text: string): void;
    meta(change: TerminalMeta): void;
  },
): Promise<TerminalRenderer> {
  const owner: { surface?: GhosttyTerminalSurface } = {};
  const active = await GhosttyTerminalSurface.create(mount, {
    theme: terminalTheme(ports.colors),
    visible: false,
    font: { family: '"IBM Plex Mono"', size: 12 },
    onData: terminalInput(ports.input),
    onResize: ports.resize,
    onSelectionChange: () =>
      ports.selection(owner.surface?.getSelection() ?? ""),
    beforeKey: () => true,
    canActivateLink: (text) => /^https?:\/\//i.test(text),
    onLinkActivate: (text) => {
      if (/^https?:\/\//i.test(text)) {
        globalThis.open(text, "_blank", "noopener");
      }
    },
  });
  owner.surface = active;
  return {
    sink: terminalSink(active, ports.meta),
    visible: (value) => active.setVisible(value),
    theme: (colors) => active.setTheme(terminalTheme(colors)),
    focus: () => active.focus(),
    paste: (text) => active.paste(text),
    submit: () => active.submit(),
    erase: (count) => active.erase(count),
    bracketedPaste: () => active.bracketedPaste(),
    selection: () => active.getSelection(),
    dispose: () => active.dispose(),
  };
}
