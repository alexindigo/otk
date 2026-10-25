// SPDX-License-Identifier: LGPL-3.0-only
import { onCleanup, onSettled } from "solid-js";
import type { ContextTarget } from "@otk/client";
import { useCommandPorts } from "../keyboard/context.tsx";
import {
  browserContextTargets,
  nativeTextContext,
  registerBrowserContextCommands,
} from "../features/context-menu.ts";
import { contextTargets } from "./context-target.ts";
import CommandMenu from "./CommandMenu.tsx";
import type { PopoverControl, PopoverOpenReason } from "./surface/Popover.tsx";

/** One listener owner per shell. Targets declare data; commands own behavior. */
export default function ContextMenu(
  props: { root: HTMLElement },
): import("solid-js").Element {
  const { commands } = useCommandPorts();
  let targets: ContextTarget[] = [];
  let menu!: PopoverControl, returnFocus = () => {};
  onCleanup(registerBrowserContextCommands(commands));
  const open = (
    path: EventTarget[],
    x: number,
    y: number,
    focused: HTMLElement | null,
    reason: PopoverOpenReason,
    width = 0,
    height = 0,
  ) => {
    menu.close(() => {});
    targets = focused === document.body && reason === "keyboard"
      ? []
      : browserContextTargets(
        path,
        (node) => contextTargets([node]),
        reason === "pointer" ? { x, y } : undefined,
      );
    returnFocus = () => {
      if (focused?.isConnected) focused.focus();
    };
    const origin =
      path.find((node): node is HTMLElement => node instanceof HTMLElement) ??
        props.root;
    menu.open({ x, y, width, height, origin, focus: returnFocus }, reason);
  };
  onSettled(() => {
    const root = props.root;
    let rightPressed = false, pending: (() => void) | undefined;
    let opening: ReturnType<typeof setTimeout> | undefined;
    const finish = () => {
      const invoke = pending;
      pending = undefined;
      clearTimeout(opening);
      // Native auto-popover light-dismiss finishes with pointerup. Open in the
      // following task, so the invoking gesture cannot dismiss its own menu.
      if (invoke) opening = setTimeout(invoke, 0);
    };
    const press = (event: PointerEvent) => {
      if (event.button === 2) {
        rightPressed = true;
        pending = undefined;
        clearTimeout(opening);
      }
    };
    const release = (event: PointerEvent) => {
      if (event.button !== 2) return;
      rightPressed = false;
      finish();
    };
    const pointer = (event: MouseEvent) => {
      if (event.shiftKey) return;
      if (nativeTextContext(event.composedPath())) {
        pending = undefined;
        clearTimeout(opening);
        menu.close(() => {});
        return;
      }
      event.preventDefault();
      if (event.target instanceof Node && menu.contains(event.target)) return;
      const focused = document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
      const path = event.composedPath(), x = event.clientX, y = event.clientY;
      pending = () => open(path, x, y, focused, "pointer");
      if (!rightPressed) finish();
    };
    const keyboard = (event: KeyboardEvent) => {
      if (event.isComposing || event.repeat || event.defaultPrevented) return;
      if (
        event.key !== "ContextMenu" &&
        !(event.key === "F10" && event.shiftKey && !event.ctrlKey &&
          !event.altKey && !event.metaKey)
      ) return;
      const focused = document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
      if (focused && focused !== document.body && !root.contains(focused)) {
        return;
      }
      if (nativeTextContext(event.composedPath())) {
        pending = undefined;
        clearTimeout(opening);
        menu.close(() => {});
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      pending = undefined;
      clearTimeout(opening);
      const origin = focused && focused !== document.body ? focused : root;
      const rect = origin.getBoundingClientRect();
      open(
        origin === root ? [root] : event.composedPath(),
        rect.left,
        rect.top,
        focused,
        "keyboard",
        origin === root ? 0 : rect.width,
        origin === root ? 0 : rect.height,
      );
    };
    const cancel = () => {
      rightPressed = false;
      pending = undefined;
      clearTimeout(opening);
    };
    root.addEventListener("contextmenu", pointer, true);
    root.addEventListener("pointerdown", press, true);
    root.addEventListener("pointerup", release, true);
    root.addEventListener("pointercancel", cancel, true);
    document.addEventListener("keydown", keyboard, true);
    return () => {
      root.removeEventListener("contextmenu", pointer, true);
      root.removeEventListener("pointerdown", press, true);
      root.removeEventListener("pointerup", release, true);
      root.removeEventListener("pointercancel", cancel, true);
      document.removeEventListener("keydown", keyboard, true);
      clearTimeout(opening);
    };
  });
  return (
    <CommandMenu
      label="Context menu"
      class="otk-context-menu"
      targets={() => targets}
      beforeRun={() => returnFocus()}
      control={(control) => {
        menu = control;
      }}
      onClose={() => {
        targets = [];
        returnFocus = () => {};
      }}
    />
  );
}
