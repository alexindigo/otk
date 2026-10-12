// SPDX-License-Identifier: LGPL-3.0-only
/** The viewport owns intent and its own flow geometry, not renderer internals. */
export function followViewport(
  viewport: HTMLElement,
  flow: HTMLElement,
  older: () => void,
) {
  let following = true, gesture = false, dragging = false, internal = false;
  let pressed = false, startX = 0, startY = 0;
  let disposed = false, paging = false, previousHeight = 0, pageTop = 0;
  let frame: number | undefined;
  const bottom = () =>
    viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop < 24;
  const adjust = (top: number) => {
    internal = true;
    viewport.scrollTop = top;
  };
  const schedule = () => {
    if (disposed || frame !== undefined || !following || paging || dragging) {
      return;
    }
    frame = requestAnimationFrame(() => {
      frame = undefined;
      if (!disposed && following && !paging && !dragging) {
        adjust(viewport.scrollHeight);
      }
    });
  };
  const scroll = () => {
    const own = internal;
    internal = false;
    if (gesture || dragging) {
      following = bottom();
      if (following) schedule();
    } else if (own) { /* Layout/programmatic movement preserves intent. */ }
    if (viewport.scrollTop < 24 && !paging) older();
  };
  const wheel = (event: WheelEvent) => {
    gesture = true;
    if (event.deltaY < 0) following = false;
  };
  const down = (event: PointerEvent) => {
    pressed = true;
    startX = event.clientX;
    startY = event.clientY;
    const rect = viewport.getBoundingClientRect();
    dragging = event.target === viewport &&
      event.clientX >= rect.left + viewport.clientLeft + viewport.clientWidth;
    if (dragging) gesture = true;
  };
  const move = (event: PointerEvent) => {
    if (pressed && (event.clientX !== startX || event.clientY !== startY)) {
      dragging = true;
      gesture = true;
    }
  };
  const touch = () => {
    pressed = true;
  };
  const touchMove = () => {
    if (pressed) {
      dragging = true;
      gesture = true;
    }
  };
  const up = () => {
    pressed = false;
    if (dragging) {
      dragging = false;
      following = bottom();
      schedule();
    }
  };
  const end = () => {
    if (!dragging) gesture = false;
    internal = false;
  };
  const key = (event: KeyboardEvent) => {
    const target = event.target;
    if (
      target instanceof Element &&
      target.closest("input,textarea,[contenteditable=true]")
    ) return;
    if (
      ["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " "]
        .includes(event.key)
    ) {
      gesture = true;
      if (["ArrowUp", "PageUp", "Home"].includes(event.key)) following = false;
    }
  };
  const observer = new ResizeObserver(schedule);
  observer.observe(flow);
  observer.observe(viewport);
  viewport.addEventListener("scroll", scroll);
  viewport.addEventListener("scrollend", end);
  viewport.addEventListener("wheel", wheel, { passive: true });
  viewport.addEventListener("pointerdown", down);
  viewport.addEventListener("pointermove", move);
  viewport.addEventListener("touchstart", touch, { passive: true });
  viewport.addEventListener("touchmove", touchMove, { passive: true });
  viewport.addEventListener("keydown", key);
  document.addEventListener("pointerup", up);
  document.addEventListener("pointercancel", up);
  document.addEventListener("touchend", up);
  document.addEventListener("touchcancel", up);
  schedule();
  return {
    reset() {
      following = true;
      gesture =
        dragging =
        pressed =
        internal =
        paging =
          false;
      schedule();
    },
    update(isPaging: boolean) {
      if (isPaging && !paging) {
        paging = true;
        previousHeight = viewport.scrollHeight;
        pageTop = viewport.scrollTop;
      } else if (!isPaging && paging) {
        paging = false;
        adjust(pageTop + viewport.scrollHeight - previousHeight);
        schedule();
      }
    },
    dispose() {
      disposed = true;
      if (frame !== undefined) cancelAnimationFrame(frame);
      observer.disconnect();
      viewport.removeEventListener("scroll", scroll);
      viewport.removeEventListener("scrollend", end);
      viewport.removeEventListener("wheel", wheel);
      viewport.removeEventListener("pointerdown", down);
      viewport.removeEventListener("pointermove", move);
      viewport.removeEventListener("touchstart", touch);
      viewport.removeEventListener("touchmove", touchMove);
      viewport.removeEventListener("keydown", key);
      document.removeEventListener("pointerup", up);
      document.removeEventListener("pointercancel", up);
      document.removeEventListener("touchend", up);
      document.removeEventListener("touchcancel", up);
    },
  };
}
