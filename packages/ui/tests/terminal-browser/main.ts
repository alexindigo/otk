// SPDX-License-Identifier: LGPL-3.0-only
import { GhosttyTerminalSurface } from "../../terminal/ghostty/surface.ts";
import { terminalSink } from "../../terminal/adapter.ts";

const mounts = [
  document.querySelector<HTMLElement>("#visible")!,
  document.querySelector<HTMLElement>("#hidden")!,
];
const links: string[] = [];
const input: string[] = [];
const hover: { text: string | null; at: number }[] = [];
let clipboardRead: ((text: string) => void) | undefined;
const surfaces: GhosttyTerminalSurface[] = [];
for (const mount of mounts) {
  Object.assign(mount.style, {
    width: "1000px",
    height: "600px",
    position: "relative",
  });
  surfaces.push(
    await GhosttyTerminalSurface.create(mount, {
      theme: {
        background: { r: 20, g: 20, b: 20 },
        foreground: { r: 230, g: 230, b: 230 },
        cursor: { r: 255, g: 77, b: 0 },
      },
      onData(data) {
        input.push(
          typeof data === "string" ? data : new TextDecoder().decode(data),
        );
      },
      onResize() {},
      onSelectionChange() {},
      beforeKey: () => true,
      onLinkActivate: (link) => links.push(link),
      canActivateLink: () => true,
      onLinkHover: (text) => hover.push({ text, at: performance.now() }),
    }),
  );
}
const encode = (text: string) => new TextEncoder().encode(text);
const sinks = surfaces.map((surface) => terminalSink(surface, () => {}));
Object.assign(globalThis, {
  terminalFixture: {
    links,
    input,
    hover,
    startPaste() {
      Object.defineProperty(navigator, "clipboard", {
        configurable: true,
        value: {
          readText: () =>
            new Promise<string>((resolve) => clipboardRead = resolve),
        },
      });
      surfaces[0].focus();
      surfaces[0].input.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "v",
          code: "KeyV",
          ctrlKey: true,
          shiftKey: true,
          bubbles: true,
        }),
      );
      if (!clipboardRead) {
        throw new Error("keyboard shortcut did not start a clipboard read");
      }
    },
    hide() {
      surfaces[0].setVisible(false);
      mounts[0].style.display = "none";
    },
    async completePaste(text: string) {
      clipboardRead!(text);
      for (let i = 0; i < 8; i++) await Promise.resolve();
    },
    nativePaste(text: string) {
      const data = new DataTransfer();
      data.setData("text/plain", text);
      surfaces[0].input.dispatchEvent(
        new ClipboardEvent("paste", {
          clipboardData: data,
          bubbles: true,
          cancelable: true,
        }),
      );
    },
    changeLinkRow() {
      surfaces[0].write("\x1b[1;15Hchanged-adjacent");
    },
    async scrollback() {
      surfaces[0].write(
        Array.from({ length: 120 }, (_, i) => "row-" + i + "\r\n").join(""),
      );
      await new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
      );
      surfaces[0].scrollbar.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Home", bubbles: true }),
      );
      await new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
      );
    },
    armScrollMove() {
      surfaces[0].scrollbar.addEventListener(
        "pointermove",
        () => surfaces[0].scrollToBottom(),
        { capture: true, once: true },
      );
    },
    async direction(value: string) {
      mounts[0].style.direction = value;
      sinks[0].reset(100, 30, encode("\x1b[?1049h\x1b[?25labc東end"));
      await new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
      );
    },
    hiddenCheckpoint() {
      const bytes = encode("\x1b[?1049h\x1b[20;50Hhidden-checkpoint");
      for (const sink of sinks) sink.reset(100, 30, bytes);
      mounts[1].style.display = "block";
      surfaces[1].fit();
      return surfaces.map((surface) => {
        surface.selectAll();
        return surface.getSelection();
      });
    },
    prepareLink() {
      sinks[0].reset(
        100,
        30,
        encode("\x1b]8;;https://a.test/\x1b\\link-A\x1b]8;;\x1b\\"),
      );
    },
    pendingLink() {
      surfaces[0].write(
        "\x1b[?2026h\x1b[H\x1b]8;;https://b.test/\x1b\\link-B\x1b]8;;\x1b\\",
      );
    },
    finishLink() {
      surfaces[0].write("\x1b[?2026l");
    },
    async concealed(text: string) {
      sinks[0].reset(
        100,
        30,
        encode("\x1b[?1049h\x1b[8m" + text + "\x1b[0m\r\x1b[2 q"),
      );
      surfaces[0].focus();
      await new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
      );
    },
    dispose() {
      for (const surface of surfaces) surface.dispose();
    },
  },
});
document.documentElement.dataset.ready = "true";
