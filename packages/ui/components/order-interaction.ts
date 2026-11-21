// SPDX-License-Identifier: LGPL-3.0-only
import { createEffect, createSignal, onCleanup } from "solid-js";

/** DOM input borrows an ordering hold; ranking and timers stay with the client
 * owner. A menu/dialog opened here retains the hold across its portal. */
export function orderInteraction(
  hold: () => () => void,
  owner?: () => unknown,
) {
  const [node, setNode] = createSignal<HTMLElement>();
  let cleanup = () => {};
  let boundElement: HTMLElement | undefined, boundOwner: unknown;
  createEffect(
    () => ({ element: node(), owner: owner?.() }),
    ({ element, owner }) => {
      // Resource getters invalidate on metadata too. Only an actual DOM/owner
      // replacement may retire input and portalled-origin lifetimes.
      if (element === boundElement && owner === boundOwner) return;
      cleanup();
      boundElement = element;
      boundOwner = owner;
      if (!element) return;
      let release: (() => void) | undefined;
      const retained = new Set<() => void>();
      let pointer = false, pressed = false, engaged = false, alive = true;
      const update = () => {
        if (!alive) return;
        const focused = element.contains(document.activeElement);
        const local = pointer || pressed || focused;
        const portal = retained.size > 0 || engaged &&
            !!document.querySelector("dialog[open]");
        engaged = local || portal;
        if (engaged && !release) release = hold();
        else if (!engaged && release) {
          release();
          release = undefined;
        }
      };
      const enter = () => {
        pointer = true;
        update();
      };
      const leave = () => {
        pointer = false;
        update();
      };
      const down = () => {
        pressed = true;
        update();
      };
      const up = () => {
        pressed = false;
        update();
      };
      const later = () => queueMicrotask(update);
      const retain: EventListener = (event) => {
        const releases = (event as CustomEvent<{ release: (() => void)[] }>)
          .detail?.release;
        if (!releases) return;
        const held = hold();
        const done = () => {
          held();
          retained.delete(done);
          update();
        };
        retained.add(done);
        releases.push(done);
        update();
      };
      element.addEventListener("pointerenter", enter);
      element.addEventListener("pointerleave", leave);
      element.addEventListener("pointerdown", down);
      document.addEventListener("pointerup", up, true);
      document.addEventListener("pointercancel", up, true);
      element.addEventListener("focusin", update);
      element.addEventListener("focusout", later);
      element.addEventListener("otk-context-retain", retain);
      document.addEventListener("toggle", later, true);
      document.addEventListener("close", later, true);
      pointer = element.matches(":hover");
      update();
      cleanup = () => {
        alive = false;
        element.removeEventListener("pointerenter", enter);
        element.removeEventListener("pointerleave", leave);
        element.removeEventListener("pointerdown", down);
        document.removeEventListener("pointerup", up, true);
        document.removeEventListener("pointercancel", up, true);
        element.removeEventListener("focusin", update);
        element.removeEventListener("focusout", later);
        element.removeEventListener("otk-context-retain", retain);
        document.removeEventListener("toggle", later, true);
        document.removeEventListener("close", later, true);
        release?.();
        release = undefined;
        for (const done of retained) done();
      };
    },
  );
  onCleanup(() => cleanup());
  return (element: HTMLElement) => setNode(element);
}
