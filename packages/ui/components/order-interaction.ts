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
      let pointer = false, pressed = false, alive = true;
      let activated = false, tabbing = false;
      const update = () => {
        if (!alive) return;
        const focused = element.contains(document.activeElement);
        const local = !activated && (pointer || pressed || focused);
        const engaged = local || retained.size > 0;
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
        activated = false;
        pressed = true;
        update();
      };
      const up = () => {
        pressed = false;
        update();
      };
      const later = () => queueMicrotask(update);
      // A hold protects a target while the reader chooses, not after an
      // explicit intent changes selection, query or membership. Focus return
      // from that intent must not resurrect the preceding interaction.
      const activate = (portalled = false) => {
        activated = true;
        if (portalled) { for (const done of [...retained]) done(); }
        update();
      };
      const input = () => activate();
      const resume = () => {
        activated = false;
        update();
      };
      const keyboard = (event: KeyboardEvent) => {
        tabbing = event.key === "Tab";
        queueMicrotask(() => tabbing = false);
        if (event.target instanceof Node && element.contains(event.target)) {
          resume();
        }
      };
      const focus = () => tabbing ? resume() : update();
      const layer = (event: Event) => {
        // A native modal takes interaction away from the underlying inert
        // document. Its focus return is not a new choice in that document.
        if (
          event.target instanceof HTMLDialogElement && event.target.open &&
          event.target.matches(":modal")
        ) activate(true);
        else later();
      };
      const retain: EventListener = (event) => {
        const detail = (event as CustomEvent<{
          release: (() => void)[];
          activate?: (() => void)[];
        }>).detail;
        const releases = detail?.release;
        if (!releases) return;
        const held = hold();
        const done = () => {
          held();
          retained.delete(done);
          update();
        };
        retained.add(done);
        releases.push(done);
        detail.activate?.push(() => activate(true));
        update();
      };
      element.addEventListener("pointerenter", enter);
      element.addEventListener("pointerleave", leave);
      element.addEventListener("pointerdown", down);
      element.addEventListener("pointermove", resume);
      element.addEventListener("click", input);
      element.addEventListener("input", input);
      document.addEventListener("keydown", keyboard, true);
      document.addEventListener("pointerup", up, true);
      document.addEventListener("pointercancel", up, true);
      element.addEventListener("focusin", focus);
      element.addEventListener("focusout", later);
      element.addEventListener("otk-context-retain", retain);
      document.addEventListener("toggle", layer, true);
      document.addEventListener("close", later, true);
      pointer = element.matches(":hover");
      update();
      cleanup = () => {
        alive = false;
        element.removeEventListener("pointerenter", enter);
        element.removeEventListener("pointerleave", leave);
        element.removeEventListener("pointerdown", down);
        element.removeEventListener("pointermove", resume);
        element.removeEventListener("click", input);
        element.removeEventListener("input", input);
        document.removeEventListener("keydown", keyboard, true);
        document.removeEventListener("pointerup", up, true);
        document.removeEventListener("pointercancel", up, true);
        element.removeEventListener("focusin", focus);
        element.removeEventListener("focusout", later);
        element.removeEventListener("otk-context-retain", retain);
        document.removeEventListener("toggle", layer, true);
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
