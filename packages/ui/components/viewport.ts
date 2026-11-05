// SPDX-License-Identifier: LGPL-3.0-only
import type { WindowAnchor } from "@otk/client";

/** One DOM measurement boundary reports native source identities, never reply counts. */
export function sourceViewport(
  viewport: HTMLElement,
  order: () => readonly string[],
  change: (range: { first: string; last: string } | undefined) => void,
) {
  const ids = new Map<Element, string>(), visible = new Set<Element>();
  let scheduled: number | undefined, disposed = false, previous = "";
  const publish = () => {
    scheduled = undefined;
    if (disposed) return;
    const ranks = new Map(order().map((id, index) => [id, index]));
    const sources = [
      ...new Set([...visible].map((element) => ids.get(element)!)),
    ].filter((id) => ranks.has(id)).sort((a, b) =>
      ranks.get(a)! - ranks.get(b)!
    );
    const first = sources[0],
      last = sources.at(-1),
      key = JSON.stringify([first, last]);
    if (key === previous) return;
    previous = key;
    change(first && last ? { first, last } : undefined);
  };
  const refresh = () => {
    if (!disposed && scheduled === undefined) {
      scheduled = requestAnimationFrame(publish);
    }
  };
  const observer = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (entry.isIntersecting) visible.add(entry.target);
      else visible.delete(entry.target);
    }
    refresh();
  }, { root: viewport });
  return {
    attach(element: HTMLElement, id: string) {
      ids.set(element, id);
      observer.observe(element);
      return () => {
        observer.unobserve(element);
        ids.delete(element);
        visible.delete(element);
        refresh();
      };
    },
    dispose() {
      disposed = true;
      if (scheduled !== undefined) cancelAnimationFrame(scheduled);
      observer.disconnect();
      ids.clear();
      visible.clear();
      change(undefined);
    },
  };
}

export interface ViewportGeometry {
  id: string;
  depth: number;
  distance?(): number;
  anchor(): WindowAnchor | undefined;
  resolve(anchor: WindowAnchor): number | undefined;
}
export interface ViewportTarget {
  start: number;
  end: number;
  measured: boolean;
  anchor?: { id: string; key: string; start: number };
}
export interface ViewportPosition {
  following(): boolean;
  follow(): void;
  keepAnchor(): void;
  layout(): void;
  register(geometry: ViewportGeometry): () => void;
  remap(
    id: string,
    change: (anchor: WindowAnchor) => WindowAnchor | undefined,
  ): void;
  subscribe(change: () => void): () => void;
  navigate(
    target: () => ViewportTarget | undefined,
    align?: "center" | "nearest" | "start",
  ): Promise<void>;
  observe(flow: HTMLElement): () => void;
  dispose(): void;
}
const positions = new WeakMap<
  HTMLElement,
  { owner: ViewportPosition; users: number }
>();

/** Every borrower of a root acquires this same authority; models never scroll. */
export function acquireViewport(
  viewport: HTMLElement,
): { owner: ViewportPosition; release(): void } {
  let entry = positions.get(viewport);
  if (!entry) {
    entry = { owner: createViewportPosition(viewport), users: 0 };
    positions.set(viewport, entry);
  }
  entry.users++;
  const current = entry;
  let live = true;
  return {
    owner: current.owner,
    release() {
      if (!live) return;
      live = false;
      if (--current.users === 0) {
        current.owner.dispose();
        positions.delete(viewport);
      }
    },
  };
}

/** Sole owner of both scroll intent and application. Geometry is borrowed from
 * createWindow-backed windows; capture/resolve never duplicates prefix math. */
function createViewportPosition(viewport: HTMLElement): ViewportPosition {
  const geometries = new Map<string, ViewportGeometry>(),
    listeners = new Set<() => void>();
  const flows = new Map<HTMLElement, number>();
  let mode: "follow" | "anchored" = "anchored",
    disposed = false,
    dragging = false,
    pressed = false;
  let gesture: "toward" | "away" | undefined,
    gestureMoved = false,
    startX = 0,
    startY = 0;
  let position = viewport.scrollTop,
    frame: number | undefined,
    revision = 0,
    quiet = 0,
    appliedRevision = -1;
  let anchors: { id: string; anchor: WindowAnchor }[] = [];
  let geometryPending = true;
  let navigation: {
    target: () => ViewportTarget | undefined;
    align: "center" | "nearest" | "start";
    resolve(): void;
    reject(error: Error): void;
    signature?: string;
    stable: number;
  } | undefined;
  const clamp = (top: number) =>
    Math.max(
      0,
      Math.min(top, Math.max(0, viewport.scrollHeight - viewport.clientHeight)),
    );
  const bottom = () =>
    viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop < 24;
  const notify = () => {
    for (const change of listeners) change();
  };
  const capture = () => {
    if (mode === "follow") {
      anchors = [];
      return;
    }
    anchors = [...geometries.values()].sort((a, b) =>
      (a.distance?.() ?? 0) - (b.distance?.() ?? 0) || b.depth - a.depth
    ).flatMap((geometry) => {
      const anchor = geometry.anchor();
      return anchor
        ? [{
          id: geometry.id,
          anchor: { key: anchor.key, offset: anchor.offset },
        }]
        : [];
    });
  };
  const cancelNavigation = (reason = "Viewport intent superseded") => {
    const old = navigation;
    navigation = undefined;
    old?.reject(new DOMException(reason, "AbortError"));
  };
  function applyPosition(top: number) {
    const value = clamp(top);
    if (viewport.scrollTop !== value) viewport.scrollTop = value;
    position = viewport.scrollTop;
    notify();
  }
  const externalPosition = () => {
    const top = viewport.scrollTop, expected = clamp(position);
    if (Math.abs(top - expected) <= 1) return false;
    if (gesture) gestureMoved = true;
    position = top;
    if ((gesture || dragging) && mode === "anchored") {
      if (geometryPending) {
        // Reader motion is a displacement of the saved identities, even when
        // their DOM offsets have already changed in this layout transaction.
        const delta = top - expected;
        anchors = anchors.map(({ id, anchor }) => ({
          id,
          anchor: { key: anchor.key, offset: anchor.offset + delta },
        }));
        schedule();
      } else capture();
      return false;
    }
    // Only an accepted input/intent supersedes navigation. Native clamping of
    // the old range can arrive after a reveal was requested, before it applies.
    if (
      gesture || dragging || navigation ||
      (geometryPending && (mode === "anchored" || geometries.size > 0))
    ) return false;
    if (frame !== undefined) cancelAnimationFrame(frame);
    frame = undefined;
    geometryPending = false;
    cancelNavigation();
    capture();
    return true;
  };
  const schedule = () => {
    if (!disposed && frame === undefined) frame = requestAnimationFrame(apply);
  };
  function apply() {
    frame = undefined;
    if (disposed) return;
    if (externalPosition()) return;
    const request = navigation;
    if (request) {
      try {
        const target = request.target();
        if (!target) {
          schedule();
          return;
        }
        const wanted = request.align === "center"
          ? (target.start + target.end - viewport.clientHeight) / 2
          : request.align === "start"
          ? target.start
          : target.start < viewport.scrollTop
          ? target.start
          : target.end > viewport.scrollTop + viewport.clientHeight
          ? target.end - viewport.clientHeight
          : viewport.scrollTop;
        applyPosition(wanted);
        const signature = JSON.stringify([
          target.end - target.start,
          target.start - position,
          target.end - position,
        ]);
        request.stable = target.measured && signature === request.signature
          ? request.stable + 1
          : 0;
        request.signature = signature;
        if (request.stable >= 2) {
          navigation = undefined;
          geometryPending = false;
          if (target.anchor) {
            anchors = [{
              id: target.anchor.id,
              anchor: {
                key: target.anchor.key,
                offset: position - target.anchor.start,
              },
            }];
          } else capture();
          request.resolve();
        } else schedule();
      } catch (error) {
        navigation = undefined;
        request.reject(
          error instanceof Error ? error : new Error(String(error)),
        );
      }
      return;
    }
    if (mode === "follow") applyPosition(viewport.scrollHeight);
    else {
      for (const saved of anchors) {
        const top = geometries.get(saved.id)?.resolve(saved.anchor);
        if (top !== undefined) {
          applyPosition(top);
          break;
        }
      }
      notify();
    }
    quiet = appliedRevision === revision ? quiet + 1 : 0;
    appliedRevision = revision;
    if (quiet < 2) schedule();
    else {
      geometryPending = false;
      if (!anchors.length) capture();
    }
  }
  const layout = () => {
    geometryPending = true;
    revision++;
    schedule();
  };
  const scroll = () => {
    const changed = externalPosition();
    position = viewport.scrollTop;
    if (gesture || dragging) {
      if (dragging) mode = bottom() ? "follow" : "anchored";
      else if (gesture === "toward" && (mode === "follow" || bottom())) {
        mode = "follow";
      }
      if (!geometryPending) capture();
      else schedule();
      if (mode === "follow") schedule();
    } else if (changed && !navigation && !geometryPending) capture();
    notify();
  };
  const away = () => {
    cancelNavigation();
    const captureNow = mode !== "anchored" || !geometryPending;
    mode = "anchored";
    if (captureNow) capture();
  };
  const beginGesture = (direction: "away" | "toward") => {
    gesture = direction;
    gestureMoved = false;
    if (gesture === "away") away();
    else if (bottom()) mode = "follow";
    // An input intent at a native boundary cannot produce a scrollend event.
    // Settle that intent here rather than indefinitely blocking geometry work.
    if (
      (gesture === "away" && viewport.scrollTop <= 0) ||
      (gesture === "toward" &&
        viewport.scrollTop >= viewport.scrollHeight - viewport.clientHeight)
    ) {
      gesture = undefined;
      layout();
    }
  };
  const wheel = (event: WheelEvent) =>
    beginGesture(event.deltaY < 0 ? "away" : "toward");
  const down = (event: PointerEvent) => {
    cancelNavigation();
    capture();
    pressed = true;
    startX = event.clientX;
    startY = event.clientY;
    const rect = viewport.getBoundingClientRect();
    dragging = event.target === viewport &&
      event.clientX >= rect.left + viewport.clientLeft + viewport.clientWidth;
    if (dragging) {
      gesture = undefined;
      away();
    }
  };
  const move = (event: PointerEvent) => {
    if (pressed && (event.clientX !== startX || event.clientY !== startY)) {
      dragging = true;
      gesture = undefined;
      away();
    }
  };
  const touch = () => {
    pressed = true;
  };
  const touchMove = () => {
    if (pressed) {
      dragging = true;
      gesture = undefined;
      away();
    }
  };
  const up = () => {
    pressed = false;
    if (dragging) {
      dragging = false;
      mode = bottom() ? "follow" : "anchored";
      if (!geometryPending) capture();
      schedule();
    }
  };
  const end = () => {
    const userGesture = !!gesture || dragging;
    // A previous programmatic scroll can end after new input was accepted but
    // before its native displacement/notification. Join that displacement while
    // its intent still owns the anchors; an unrelated ending cannot retire it.
    if (userGesture) externalPosition();
    if (gesture && !gestureMoved) return;
    gesture = undefined;
    if (userGesture && !geometryPending) capture();
    if (geometryPending) schedule();
  };
  const key = (event: KeyboardEvent) => {
    if (
      event.target instanceof Element &&
      event.target.closest(
        "input,textarea,[contenteditable=true],button,a,select,summary,[role=button]",
      )
    ) {
      cancelNavigation();
      capture();
      return;
    }
    if (
      ["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " "]
        .includes(event.key)
    ) {
      beginGesture(
        ["ArrowUp", "PageUp", "Home"].includes(event.key) ||
          (event.key === " " && event.shiftKey)
          ? "away"
          : "toward",
      );
    }
  };
  const observer = new ResizeObserver(layout);
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
  return {
    following: () => mode === "follow",
    follow() {
      cancelNavigation();
      mode = "follow";
      gesture = undefined;
      dragging = false;
      layout();
    },
    keepAnchor() {
      away();
      gesture = undefined;
      layout();
    },
    layout,
    register(geometry) {
      if (geometries.has(geometry.id)) {
        throw new Error(`Duplicate viewport geometry: ${geometry.id}`);
      }
      geometries.set(geometry.id, geometry);
      if (!anchors.length && mode === "anchored") capture();
      layout();
      return () => {
        if (geometries.get(geometry.id) === geometry) {
          geometries.delete(geometry.id);
        }
      };
    },
    remap(id, change) {
      anchors = anchors.flatMap((saved) => {
        if (saved.id !== id) return [saved];
        const anchor = change(saved.anchor);
        return anchor ? [{ id, anchor }] : [];
      });
    },
    subscribe(change) {
      listeners.add(change);
      return () => {
        listeners.delete(change);
      };
    },
    navigate(target, align = "nearest") {
      if (disposed) {
        return Promise.reject(
          new DOMException("Viewport retired", "AbortError"),
        );
      }
      cancelNavigation();
      mode = "anchored";
      gesture = undefined;
      dragging = false;
      return new Promise<void>((resolve, reject) => {
        navigation = { target, align, resolve, reject, stable: 0 };
        layout();
      });
    },
    observe(flow) {
      flows.set(flow, (flows.get(flow) ?? 0) + 1);
      observer.observe(flow);
      layout();
      return () => {
        const count = (flows.get(flow) ?? 1) - 1;
        if (count) flows.set(flow, count);
        else {
          flows.delete(flow);
          if (flow !== viewport) observer.unobserve(flow);
        }
      };
    },
    dispose() {
      disposed = true;
      cancelNavigation("Viewport retired");
      if (frame !== undefined) cancelAnimationFrame(frame);
      observer.disconnect();
      geometries.clear();
      listeners.clear();
      flows.clear();
      anchors = [];
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

/** Transcript compatibility facade: intent requests to the same root owner used
 * by VirtualList, not another scroll controller or measurement observer. */
export function followViewport(
  viewport: HTMLElement,
  flow: HTMLElement,
  range?: () => void,
) {
  const lease = acquireViewport(viewport), owner = lease.owner;
  const releaseFlow = owner.observe(flow),
    releaseRange = range ? owner.subscribe(range) : () => {};
  owner.follow();
  return {
    following: owner.following,
    pause: owner.keepAnchor,
    reset: owner.follow,
    update(_paging: boolean) {
      owner.layout();
    },
    dispose() {
      releaseRange();
      releaseFlow();
      lease.release();
    },
  };
}
