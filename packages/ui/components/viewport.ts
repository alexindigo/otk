// SPDX-License-Identifier: LGPL-3.0-only
/** The viewport owns intent and its own flow geometry, not renderer internals. */
export function followViewport(
  viewport: HTMLElement,
  flow: HTMLElement,
  older: () => void,
) {
  let following = true, dragging = false;
  let gesture: "toward" | "away" | undefined;
  let pressed = false, startX = 0, startY = 0;
  let disposed = false, paging = false, previousHeight = 0, pageTop = 0;
  let frame: number | undefined;
  let position = viewport.scrollTop, intent = 0;
  const invalidateFollow = () => {
    intent++;
    if (frame !== undefined) cancelAnimationFrame(frame);
    frame = undefined;
  };
  const observePosition = () => {
    const top = viewport.scrollTop;
    // Native layout can clamp a previous position when the scroll range shrinks.
    const expected = Math.max(
      0,
      Math.min(position, viewport.scrollHeight - viewport.clientHeight),
    );
    position = top;
    if (top !== expected && !gesture && !dragging) {
      // A later external position supersedes already-requested layout follow,
      // even if its native scroll notification has not arrived yet.
      invalidateFollow();
      return true;
    }
    return false;
  };
  const bottom = () =>
    viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop < 24;
  const adjust = (top: number) => {
    viewport.scrollTop = top;
    position = viewport.scrollTop;
  };
  const schedule = () => {
    if (observePosition()) return;
    if (disposed || frame !== undefined || !following || paging || dragging) {
      return;
    }
    const requested = intent;
    frame = requestAnimationFrame(() => {
      if (requested !== intent) return;
      frame = undefined;
      if (
        !observePosition() && !disposed && following && !paging && !dragging
      ) {
        adjust(viewport.scrollHeight);
      }
    });
  };
  const scroll = () => {
    observePosition();
    if (gesture || dragging) {
      // Input owns direction: a delayed notification can still describe the
      // previous programmatic position or an older layout. Neither can revoke
      // downward follow or undo upward intent. Direct dragging owns position.
      following = dragging
        ? bottom()
        : gesture === "toward" && (following || bottom());
      if (following) schedule();
    } // External programmatic movement preserves future follow intent.
    if (viewport.scrollTop < 24 && !paging) older();
  };
  const wheel = (event: WheelEvent) => {
    gesture = event.deltaY < 0 ? "away" : "toward";
    if (gesture === "away") following = false;
  };
  const down = (event: PointerEvent) => {
    pressed = true;
    startX = event.clientX;
    startY = event.clientY;
    const rect = viewport.getBoundingClientRect();
    dragging = event.target === viewport &&
      event.clientX >= rect.left + viewport.clientLeft + viewport.clientWidth;
    if (dragging) gesture = undefined;
  };
  const move = (event: PointerEvent) => {
    if (pressed && (event.clientX !== startX || event.clientY !== startY)) {
      dragging = true;
      gesture = undefined;
    }
  };
  const touch = () => {
    pressed = true;
  };
  const touchMove = () => {
    if (pressed) {
      dragging = true;
      gesture = undefined;
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
    if (!dragging) gesture = undefined;
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
      gesture = ["ArrowUp", "PageUp", "Home"].includes(event.key) ||
          (event.key === " " && event.shiftKey)
        ? "away"
        : "toward";
      if (gesture === "away") following = false;
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
    /** Explicit transcript navigation supersedes pending and future tail follow. */
    pause() {
      invalidateFollow();
      following = false;
      gesture = undefined;
    },
    reset() {
      invalidateFollow();
      position = viewport.scrollTop;
      following = true;
      gesture = undefined;
      dragging =
        pressed =
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
