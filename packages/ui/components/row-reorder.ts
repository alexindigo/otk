// SPDX-License-Identifier: LGPL-3.0-only
import { createSignal, onCleanup } from "solid-js";
import type { ProjectMoveTarget } from "@otk/protocol";

interface Row {
  key: string;
  id: string;
  sidecar: string;
  element(): HTMLElement | undefined;
}
interface Drop<S> {
  section: S;
  index: number;
  target: ProjectMoveTarget;
}

/** Pointer intent only. The published project order never changes here. */
export function createRowReorder<S extends string>(options: {
  items(section: S): Row[];
  scroller(): HTMLElement | undefined;
  scrollBy(delta: number): void;
  move(key: string, target: ProjectMoveTarget): Promise<void>;
  menu(key: string): void;
  failure(key: string, error: unknown): void;
}) {
  const [lift, setLift] = createSignal<string>();
  const [touchRow, setTouchRow] = createSignal<string>();
  const [drop, setDrop] = createSignal<Drop<S>>();
  let gesture: {
    section: S;
    key: string;
    element: HTMLElement;
    pointer: number;
    touch: boolean;
    startX: number;
    startY: number;
    x: number;
    y: number;
    active: boolean;
    moved: boolean;
    stop: AbortController;
  } | undefined;
  let frame = 0,
    hold: ReturnType<typeof setTimeout> | undefined,
    mounted = true;
  let suppressClick: AbortController | undefined;

  function candidate(): Drop<S> | undefined {
    const g = gesture, scroller = options.scroller();
    if (!g || !scroller) return;
    const hit = document.elementFromPoint(g.x, g.y);
    if (
      hit?.closest("[data-project-section]")?.getAttribute(
          "data-project-section",
        ) !== g.section || hit.closest(".otk-project-archive")
    ) return;
    const rows = options.items(g.section);
    const from = rows.findIndex((row) => row.key === g.key);
    if (from < 0) return;
    const source = rows[from];
    const over = hit.closest<HTMLElement>("[data-project-root]")?.dataset
      .projectRoot;
    if (
      over && rows.find((row) => row.key === over)?.sidecar !== source.sidecar
    ) return;
    const peers = rows.flatMap((row, index) => {
      const box = row.element()?.getBoundingClientRect();
      return row.sidecar === source.sidecar && box && box.height > 0
        ? [{ row, box, index }]
        : [];
    });
    const first = peers[0], last = peers.at(-1);
    if (
      peers.length < 2 || !last || g.y < first.box.top - first.box.height / 2 ||
      g.y > last.box.bottom + last.box.height / 2
    ) return;
    const others = peers.filter(({ index }) => index !== from);
    const next = others.find(({ box }) => g.y < box.top + box.height / 2);
    const previous = next ? others[others.indexOf(next) - 1] : others.at(-1);
    const to = next ? others.indexOf(next) : others.length;
    if (to === peers.findIndex(({ index }) => index === from)) return;
    if (next) {
      return {
        section: g.section,
        index: next.index,
        target: { before: next.row.id },
      };
    }
    return previous &&
      {
        section: g.section,
        index: previous.index + 1,
        target: { after: previous.row.id },
      };
  }
  function update() {
    const g = gesture;
    if (!g?.active) return;
    setDrop(g.moved ? candidate() : undefined);
  }
  function tick() {
    const g = gesture, scroller = options.scroller();
    if (!g?.active) return;
    if (g.moved && scroller) {
      const { top, bottom, left, right } = scroller.getBoundingClientRect();
      if (g.x >= left && g.x <= right && g.y >= top && g.y <= bottom) {
        const distance = Math.min(g.y - top, bottom - g.y);
        if (distance < 40) {
          const step = Math.ceil(14 * (40 - distance) / 40);
          options.scrollBy(g.y - top < bottom - g.y ? -step : step);
        }
      }
      update();
    }
    frame = requestAnimationFrame(tick);
  }
  function activate() {
    const g = gesture;
    if (!g || g.active) return;
    g.element.setPointerCapture(g.pointer);
    g.active = true;
    setLift(g.key);
    frame = requestAnimationFrame(tick);
  }
  function stop() {
    const g = gesture;
    gesture = undefined;
    setTouchRow(undefined);
    clearTimeout(hold);
    cancelAnimationFrame(frame);
    g?.stop.abort();
    if (g?.element.hasPointerCapture(g.pointer)) {
      g.element.releasePointerCapture(g.pointer);
    }
  }
  function clear() {
    setLift(undefined);
    setDrop(undefined);
  }
  function cancel() {
    stop();
    clear();
  }
  function move(event: PointerEvent) {
    const g = gesture;
    if (!g || event.pointerId !== g.pointer) return;
    g.x = event.clientX;
    g.y = event.clientY;
    const distance = Math.hypot(g.x - g.startX, g.y - g.startY);
    if (!g.active) {
      if (g.touch) {
        if (distance >= 8) cancel();
        return;
      }
      if (distance < 4) return;
      activate();
    }
    if (distance >= (g.touch ? 8 : 4)) g.moved = true;
    update();
  }
  function finish(event: PointerEvent) {
    const g = gesture;
    if (!g || event.pointerId !== g.pointer) return;
    const result = g.active && g.moved ? candidate() : undefined;
    stop();
    if (g.active) {
      // The click dispatched after this pointerup belongs to the gesture.
      suppressClick?.abort();
      const listener = suppressClick = new AbortController();
      globalThis.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopImmediatePropagation();
      }, { capture: true, once: true, signal: listener.signal });
      setTimeout(() => listener.abort(), g.touch ? 500 : 0);
    }
    if (!result) {
      clear();
      if (g.touch && g.active && !g.moved) options.menu(g.key);
      return;
    }
    setDrop(result);
    void options.move(g.key, result.target).catch((error) => {
      if (mounted) options.failure(g.key, error);
    }).finally(() => {
      if (mounted) clear();
    });
  }
  onCleanup(() => {
    mounted = false;
    stop();
    suppressClick?.abort();
  });
  return {
    handlers(section: S, key: string) {
      return {
        onPointerDown(event: PointerEvent & { currentTarget: HTMLElement }) {
          if (
            gesture || lift() || event.button !== 0 || !event.isPrimary ||
            (event.target instanceof Element &&
              event.target.closest(
                "[data-no-reorder], input, .otk-project-menu",
              ))
          ) return;
          const stop = new AbortController();
          const touch = event.pointerType === "touch";
          gesture = {
            section,
            key,
            element: event.currentTarget,
            pointer: event.pointerId,
            touch,
            startX: event.clientX,
            startY: event.clientY,
            x: event.clientX,
            y: event.clientY,
            active: false,
            moved: false,
            stop,
          };
          const listeners = { capture: true, signal: stop.signal };
          globalThis.addEventListener("pointermove", move, listeners);
          globalThis.addEventListener("pointerup", finish, listeners);
          globalThis.addEventListener("pointercancel", (e) => {
            if (e.pointerId === gesture?.pointer) cancel();
          }, listeners);
          globalThis.addEventListener("keydown", (e) => {
            if (e.key !== "Escape") return;
            e.preventDefault();
            e.stopImmediatePropagation();
            cancel();
          }, listeners);
          if (touch) {
            setTouchRow(key);
            globalThis.addEventListener("touchmove", (e) => {
              if (gesture?.active) e.preventDefault();
            }, { ...listeners, passive: false });
            hold = setTimeout(activate, 400);
          }
        },
        onLostPointerCapture(event: PointerEvent) {
          if (
            event.pointerId === gesture?.pointer &&
            event.target === gesture?.element
          ) cancel();
        },
      };
    },
    lifted: (key: string) => lift() === key,
    defersTouchMenu: (key: string) => touchRow() === key,
    active: () => lift() !== undefined,
    drop: (section: S) =>
      drop()?.section === section ? drop()?.index : undefined,
  };
}
