// SPDX-License-Identifier: LGPL-3.0-only
import type { CommandHub } from "@otk/client";
import { localKeyboard, nativeTextField } from "./ownership.ts";
import { type KeyEvent, type Keymap, makeKeymap } from "./keys.ts";

type FocusHome = () => HTMLTextAreaElement | undefined;

export interface Keyboard {
  keymap: Keymap;
  focus(): string;
  focusHome(home: FocusHome): () => void;
  layer(command: string, when?: () => boolean, rank?: number): () => void;
  onLayerClose(command: string): () => void;
  close(event: KeyEvent): boolean;
  start(target?: Document, hasSession?: () => boolean): () => void;
}

function startWindowFocus(
  doc: Document,
  hasSession: () => boolean,
  home: FocusHome,
) {
  const empty = (node: EventTarget | null) =>
    !node || node === doc || node === doc.body || node === doc.documentElement;
  let lastText: WeakRef<HTMLElement> | undefined;
  const remember = (node: EventTarget | null) => {
    if (!empty(node)) {
      lastText = nativeTextField(node) ? new WeakRef(node) : undefined;
    }
  };
  const focusIn = (event: FocusEvent) => remember(event.target);
  const available = (node: HTMLElement | undefined): node is HTMLElement =>
    !!node && node.isConnected && !node.closest("[inert], :disabled") &&
    node.checkVisibility({ visibilityProperty: true });
  const restore = () => {
    if (
      doc.visibilityState !== "visible" || !hasSession() ||
      !empty(doc.activeElement) ||
      doc.querySelector("dialog[open], :popover-open") ||
      doc.getSelection()?.isCollapsed === false
    ) return;

    const composer = home();
    const previous = lastText?.deref();
    if (available(previous)) {
      if (
        (previous instanceof HTMLInputElement ||
          previous instanceof HTMLTextAreaElement) &&
        previous.selectionStart !== previous.selectionEnd
      ) return;
      if (previous !== composer) {
        previous.focus({ preventScroll: true });
        if (!empty(doc.activeElement)) return;
      }
    }
    if (!composer || !available(composer)) return;
    composer.focus({ preventScroll: true });
    if (doc.activeElement === composer) {
      const end = composer.value.length;
      composer.setSelectionRange(end, end);
    }
  };
  remember(doc.activeElement);
  const window = doc.defaultView;
  doc.addEventListener("focusin", focusIn, true);
  doc.addEventListener("visibilitychange", restore);
  window?.addEventListener("focus", restore);
  return () => {
    doc.removeEventListener("focusin", focusIn, true);
    doc.removeEventListener("visibilitychange", restore);
    window?.removeEventListener("focus", restore);
  };
}

/** One listener lifetime per consumer; layers contain command IDs only. */
export function createKeyboard(
  commands: CommandHub,
  fail: (error: unknown) => void,
  mac = false,
): Keyboard {
  const invoke = (id: string, args?: unknown) => {
    void commands.run(id, args).catch(fail);
  };
  const keymap = makeKeymap({
    describe: (id) => commands.metadata(id)?.title ?? id,
    request: (binding) => {
      if (!commands.enabled(binding.command, undefined, binding.args)) {
        return false;
      }
      invoke(binding.command, binding.args);
      return true;
    },
  }, mac);
  const layers: { command: string; when: () => boolean; rank: number }[] = [];
  const resets = new Set<string>();
  let home: FocusHome | undefined;
  const close = (e: KeyEvent): boolean => {
    if (
      e.key !== "Escape" || e.isComposing || e.repeat || e.defaultPrevented ||
      localKeyboard(e.target)
    ) {
      return false;
    }
    const top =
      layers.filter((layer) => layer.when()).sort((a, b) =>
        b.rank - a.rank || layers.indexOf(b) - layers.indexOf(a)
      )[0];
    if (!top || !commands.enabled(top.command)) return false;
    e.preventDefault?.();
    for (const id of resets) if (commands.enabled(id)) invoke(id);
    invoke(top.command);
    return true;
  };
  return {
    keymap,
    focus: () => document.activeElement?.getAttribute("name") ?? "",
    focusHome(target) {
      home = target;
      return () => {
        if (home === target) home = undefined;
      };
    },
    onLayerClose(command: string): () => void {
      resets.add(command);
      return () => {
        resets.delete(command);
      };
    },
    layer(
      command: string,
      when: () => boolean = () => true,
      rank = 0,
    ): () => void {
      const layer = { command, when, rank };
      layers.push(layer);
      return () => {
        const at = layers.indexOf(layer);
        if (at >= 0) layers.splice(at, 1);
      };
    },
    close,
    start(target: Document = document, hasSession?: () => boolean): () => void {
      const stopFocus = hasSession &&
        startWindowFocus(target, hasSession, () => home?.());
      const capture = (event: KeyboardEvent) => {
        if (close(event)) event.stopPropagation();
      };
      const dispatch = (event: KeyboardEvent) => keymap.dispatch(event);
      target.addEventListener("keydown", capture, true);
      target.addEventListener("keydown", dispatch);
      return () => {
        stopFocus?.();
        target.removeEventListener("keydown", capture, true);
        target.removeEventListener("keydown", dispatch);
      };
    },
  };
}
