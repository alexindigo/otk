// SPDX-License-Identifier: LGPL-3.0-only
import type { CommandHub } from "@otk/client";
import { localKeyboard } from "./ownership.ts";
import { type KeyEvent, type Keymap, makeKeymap } from "./keys.ts";
import { createFocusOwner } from "./focus.ts";

export interface Keyboard {
  keymap: Keymap;
  focus(): string;
  focusOwner: ReturnType<typeof createFocusOwner>;
  focusHome: ReturnType<typeof createFocusOwner>["home"];
  layer(command: string, when?: () => boolean, rank?: number): () => void;
  onLayerClose(command: string): () => void;
  close(event: KeyEvent): boolean;
  start(target?: Document, hasSession?: () => boolean): () => void;
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
  const focusOwner = createFocusOwner();
  const resets = new Set<string>();
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
    focusHome: focusOwner.home,
    focusOwner,
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
      const stopFocus = focusOwner.start(target, hasSession);
      const capture = (event: KeyboardEvent) => {
        if (close(event)) event.stopPropagation();
      };
      const dispatch = (event: KeyboardEvent) => keymap.dispatch(event);
      target.addEventListener("keydown", capture, true);
      target.addEventListener("keydown", dispatch);
      return () => {
        stopFocus();
        target.removeEventListener("keydown", capture, true);
        target.removeEventListener("keydown", dispatch);
      };
    },
  };
}
