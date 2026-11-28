// SPDX-License-Identifier: LGPL-3.0-only
import { nativeTextField } from "./ownership.ts";

export type FocusOptions = globalThis.FocusOptions & { focusVisible?: boolean };
export type FocusModality = "pointer" | "keyboard";
export type SelectionFocusGroup = "project" | "tab" | "session" | "crumb";
type FocusHome = () => HTMLTextAreaElement | undefined;

function available(node: HTMLElement | null | undefined): node is HTMLElement {
  return !!node?.isConnected && !node.closest("[inert], :disabled") &&
    node.checkVisibility({ visibilityProperty: true });
}

export function focusControl(
  node: HTMLElement | null | undefined,
  options?: FocusOptions,
) {
  if (!available(node)) return false;
  node.focus(options);
  return node.ownerDocument.activeElement === node;
}

type SelectionItem = {
  group: SelectionFocusGroup;
  selected(): boolean;
  home(): HTMLElement | undefined;
};

export interface FocusOwner {
  modality(): FocusModality | undefined;
  home(target: FocusHome): () => void;
  item(root: HTMLElement, item: SelectionItem): () => void;
  returnLease(focusVisible?: boolean): (
    target: HTMLElement | undefined,
    origin: HTMLElement | undefined,
  ) => void;
  navigationChanged(): void;
  start(target: Document, hasSession?: () => boolean): () => void;
}

/** One shell lifetime owns focus handoff and lends conditional return leases. */
export function createFocusOwner(): FocusOwner {
  const items = new Map<HTMLElement, SelectionItem>();
  let doc: Document | undefined;
  let modality: FocusModality | undefined;
  let home: FocusHome | undefined;
  let revision = 0;
  let previous: {
    control: WeakRef<HTMLElement>;
    root?: WeakRef<HTMLElement>;
    item?: SelectionItem;
    visible: boolean;
  } | undefined;
  const find = (control: HTMLElement) => {
    for (
      let node: HTMLElement | null = control;
      node;
      node = node.parentElement
    ) {
      const item = items.get(node);
      if (item) return { root: new WeakRef(node), item };
    }
  };
  const remember = (control: HTMLElement) => {
    previous = {
      control: new WeakRef(control),
      ...find(control),
      visible: control.matches(":focus-visible"),
    };
  };
  const empty = (node: Element | null | undefined) =>
    !node || node === doc?.body || node === doc?.documentElement;
  const protectedFocus = () =>
    doc?.querySelector("dialog[open], :popover-open") ||
    doc?.getSelection()?.isCollapsed === false;
  const focusComposer = () => {
    const composer = home?.();
    if (composer && focusControl(composer, { preventScroll: true })) {
      const end = composer.value.length;
      composer.setSelectionRange(end, end);
    }
  };
  return {
    modality: () => modality,
    home(target: FocusHome) {
      home = target;
      return () => {
        if (home === target) home = undefined;
      };
    },
    item(root: HTMLElement, item: SelectionItem) {
      items.set(root, item);
      return () => {
        if (items.get(root) === item) items.delete(root);
      };
    },
    returnLease(focusVisible = modality === "keyboard") {
      const captured = revision;
      return (
        target: HTMLElement | undefined,
        origin: HTMLElement | undefined,
      ) => {
        if (!origin || captured !== revision || !doc || protectedFocus()) {
          return;
        }
        const active = doc.activeElement;
        const last = previous?.control.deref();
        const ownsFocus = active && origin.contains(active);
        const ownsRetiredFocus = empty(active) &&
          (previous?.root?.deref() === origin ||
            !!last && origin.contains(last));
        if (ownsFocus || ownsRetiredFocus) {
          focusControl(target, { preventScroll: true, focusVisible });
        }
      };
    },
    navigationChanged() {
      const current = ++revision;
      // Resolve the live controls after the accepted selection has rendered.
      queueMicrotask(() => {
        if (current !== revision || !doc || protectedFocus()) return;
        const active = doc.activeElement;
        const last = previous?.control.deref();
        const retired = empty(active) && !!last && !last.isConnected;
        const item = active instanceof HTMLElement && !empty(active)
          ? find(active)?.item
          : retired
          ? previous?.item
          : undefined;
        if (
          !item || (!retired && item.selected()) || nativeTextField(active)
        ) return;
        const focusVisible = previous?.visible && modality !== "pointer";
        for (const candidate of items.values()) {
          if (
            candidate.group === item.group && candidate.selected() &&
            focusControl(candidate.home(), { focusVisible })
          ) return;
        }
        focusComposer();
      });
    },
    start(target: Document, hasSession?: () => boolean) {
      doc = target;
      const window = target.defaultView;
      let frame: number | undefined, task: number | undefined;
      let pressed: number | undefined;
      const cancelRestore = () => {
        if (frame !== undefined) window?.cancelAnimationFrame(frame);
        if (task !== undefined) window?.clearTimeout(task);
        frame = task = undefined;
      };
      const pointer = (event: PointerEvent) => {
        modality = "pointer";
        pressed = event.pointerId;
        cancelRestore();
      };
      const release = (event: PointerEvent) => {
        if (event.pointerId === pressed) pressed = undefined;
      };
      const keyboard = (event: KeyboardEvent) => {
        if (
          !event.isComposing &&
          !["Alt", "Control", "Meta", "Shift"].includes(event.key)
        ) modality = "keyboard";
      };
      const focusin = (event: FocusEvent) => {
        if (event.target instanceof HTMLElement && !empty(event.target)) {
          remember(event.target);
        }
      };
      const canRestore = () =>
        pressed === undefined && target.hasFocus() &&
        target.visibilityState === "visible" && hasSession?.() &&
        empty(target.activeElement) && !protectedFocus();
      const restore = () => {
        task = undefined;
        if (!canRestore()) return;
        const last = previous?.control.deref();
        if (last && nativeTextField(last) && available(last)) {
          if (
            (last instanceof HTMLInputElement ||
              last instanceof HTMLTextAreaElement) &&
            last.selectionStart !== last.selectionEnd
          ) return;
          if (
            last !== home?.() && focusControl(last, { preventScroll: true })
          ) {
            return;
          }
        }
        focusComposer();
      };
      const reactivate = () => {
        cancelRestore();
        if (!window || !canRestore()) return;
        // Visibility can return without focus, and the focus event can precede
        // the press that activated the window. Yield a rendering opportunity
        // and a task; a pointer that arrives first owns its native default.
        frame = window.requestAnimationFrame(() => {
          frame = undefined;
          task = window.setTimeout(restore, 0);
        });
      };
      const deactivate = () => {
        pressed = undefined;
        cancelRestore();
      };
      if (
        target.activeElement instanceof HTMLElement &&
        !empty(target.activeElement)
      ) {
        remember(target.activeElement);
      }
      target.addEventListener("pointerdown", pointer, true);
      target.addEventListener("keydown", keyboard, true);
      target.addEventListener("focusin", focusin, true);
      if (hasSession) {
        target.addEventListener("pointerup", release, true);
        target.addEventListener("pointercancel", release, true);
        target.addEventListener("visibilitychange", reactivate);
        window?.addEventListener("focus", reactivate);
        window?.addEventListener("blur", deactivate);
      }
      return () => {
        target.removeEventListener("pointerdown", pointer, true);
        target.removeEventListener("keydown", keyboard, true);
        target.removeEventListener("focusin", focusin, true);
        target.removeEventListener("pointerup", release, true);
        target.removeEventListener("pointercancel", release, true);
        target.removeEventListener("visibilitychange", reactivate);
        window?.removeEventListener("focus", reactivate);
        window?.removeEventListener("blur", deactivate);
        deactivate();
        doc = undefined;
        previous = undefined;
        modality = undefined;
        revision++;
      };
    },
  };
}
