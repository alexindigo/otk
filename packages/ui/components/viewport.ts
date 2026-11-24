// SPDX-License-Identifier: LGPL-3.0-only
import type { WindowAnchor } from "@otk/client";
import { isCancellation } from "@otk/protocol";

/** A user-opened disclosure asks its nearest window to measure its frame. */
export interface ViewportRevealRequest {
  settled?: Promise<void>;
}

/** State-only changes never claim the viewport, even if they open a fold. */
export function discloseInViewport(
  element: HTMLElement | undefined,
  open: boolean,
  setOpen: (open: boolean) => void,
  user: boolean,
) {
  if (user && open && element) {
    const request: ViewportRevealRequest = {};
    element.dispatchEvent(
      new CustomEvent("otk-viewport-reveal", {
        bubbles: true,
        detail: request,
      }),
    );
    void request.settled?.catch((error) => {
      if (!isCancellation(error)) throw error;
    });
  }
  setOpen(open);
}

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
  /** Retain the source and every enclosing window row until anchor transfer. */
  retain?(anchor: WindowAnchor): () => void;
}
export interface ViewportTarget {
  start: number;
  end: number;
  measured: boolean;
  anchor?: { id: string; key: string; start: number };
}
export interface ViewportHistory {
  readonly appendRevision?: number;
  readonly first?: string;
  readonly last?: string;
  readonly exhausted: boolean;
}
export interface ViewportSnapshot {
  readonly newMessages: boolean;
  readonly revision: number;
  readonly scrollTop: number;
  readonly contentHeight: number;
  readonly distanceFromBottom: number;
  readonly viewportHeight: number;
  readonly following: boolean;
  readonly history: ViewportHistory;
}
export interface ViewportNavigation {
  align?: "center" | "nearest" | "start";
  /** Only explicit reader actions may take and pin the viewport intent. */
  intent?: "user";
}
export interface ViewportPosition {
  following(): boolean;
  /** Explicit scrollbar input shares navigation cancellation and position application. */
  input(top: number): void;
  snapshot(): ViewportSnapshot;
  subscribeSnapshot(change: (snapshot: ViewportSnapshot) => void): () => void;
  history(value: ViewportHistory): void;
  /** Acquire the authoritative live tail, then follow measured root geometry. */
  latest(ready: (signal: AbortSignal) => Promise<void>): Promise<void>;
  /** Acquire a return source only while this remains the current navigation. */
  restore(
    ready: (signal: AbortSignal) => Promise<void>,
    apply: () => Promise<void>,
  ): Promise<void>;
  follow(): void;
  keepAnchor(): void;
  layout(): void;
  /** One revision includes prefix changes, DOM materialization and compensation. */
  transaction(change: () => void): void;
  /** A descendant must record its actual size before releasing this barrier. */
  hold(): () => void;
  register(geometry: ViewportGeometry): () => void;
  remap(
    id: string,
    change: (anchor: WindowAnchor) => WindowAnchor | undefined,
  ): void;
  subscribe(change: () => void): () => void;
  navigate(
    target: () => ViewportTarget | undefined,
    options?: ViewportNavigation,
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
  let mode: "following" | "free-scrolled" | "user-pinned" = "free-scrolled",
    disposed = false,
    dragging = false,
    pressed = false;
  let gesture: "toward" | "away" | undefined,
    gestureMoved = false,
    compensated = false,
    startX = 0,
    startY = 0;
  let position = viewport.scrollTop,
    frame: number | undefined,
    revision = 0,
    leases = 0,
    changing = 0;
  let applying = false;
  let anchors: { id: string; anchor: WindowAnchor }[] = [];
  let releaseAnchor: (() => void) | undefined;
  let geometryPending = true;
  let readerCapturePending = false;
  let history: ViewportHistory = Object.freeze({ exhausted: false });
  let newMessages = false;
  let snapshot: ViewportSnapshot = Object.freeze({
    newMessages: false,
    revision: 0,
    scrollTop: viewport.scrollTop,
    contentHeight: viewport.scrollHeight,
    distanceFromBottom: Math.max(
      0,
      viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop,
    ),
    viewportHeight: viewport.clientHeight,
    following: false,
    history,
  });
  let publishedGeometry = -1;
  const snapshotListeners = new Set<(snapshot: ViewportSnapshot) => void>();
  let latest: {
    abort: AbortController;
    promise: Promise<void>;
    ready: boolean;
    resolve(): void;
    reject(reason: unknown): void;
  } | undefined;
  let navigation: {
    target: () => ViewportTarget | undefined;
    align: NonNullable<ViewportNavigation["align"]>;
    intent: ViewportNavigation["intent"];
    resolve(): void;
    reject(error: Error): void;
  } | undefined;
  let restoration: AbortController | undefined;
  const clamp = (top: number) =>
    Math.max(
      0,
      Math.min(top, Math.max(0, viewport.scrollHeight - viewport.clientHeight)),
    );
  // Only a consumer that declares a live tail (a transcript) can be followed.
  // A paged list's end is its oldest acquired row: reaching it is a position.
  let tail = false;
  const atTail = () =>
    tail &&
    viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop < 24;
  let publishing = false;
  // Transactions can commit many times in one task. Windows observe one
  // position publication per microtask checkpoint, still before paint.
  const notify = () => {
    if (publishing) return;
    publishing = true;
    queueMicrotask(() => {
      publishing = false;
      if (disposed) return;
      for (const change of listeners) change();
      // Windows can materialize descendants while observing position. Publish
      // consumer geometry only after that revision's compensation has committed.
      if (geometryPending || changing || leases) return;
      const distanceFromBottom = Math.max(
        0,
        viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop,
      );
      const viewportHeight = viewport.clientHeight,
        contentHeight = viewport.scrollHeight,
        scrollTop = viewport.scrollTop,
        following = mode === "following";
      if (following && distanceFromBottom <= 1) newMessages = false;
      if (
        publishedGeometry === revision &&
        snapshot.distanceFromBottom === distanceFromBottom &&
        snapshot.viewportHeight === viewportHeight &&
        snapshot.contentHeight === contentHeight &&
        snapshot.scrollTop === scrollTop &&
        snapshot.following === following && snapshot.history === history &&
        snapshot.newMessages === newMessages
      ) return;
      publishedGeometry = revision;
      snapshot = Object.freeze({
        newMessages,
        revision: snapshot.revision + 1,
        distanceFromBottom,
        viewportHeight,
        contentHeight,
        scrollTop,
        following,
        history,
      });
      for (const change of snapshotListeners) change(snapshot);
      // Window publication may materialize descendants and acquire leases. The
      // command settles at this same committed consumer boundary, not before it.
      if (
        latest?.ready && mode === "following" && !geometryPending && !leases &&
        publishedGeometry === revision && distanceFromBottom <= 1
      ) {
        const completed = latest;
        latest = undefined;
        completed.resolve();
      }
    });
  };
  const attach = (id: string, anchor: WindowAnchor) => {
    if (anchors[0]?.id === id && anchors[0]?.anchor.key === anchor.key) {
      anchors[0].anchor = { ...anchor };
      return;
    }
    const release = geometries.get(id)?.retain?.(anchor);
    const previous = releaseAnchor;
    anchors = [{ id, anchor: { ...anchor } }];
    releaseAnchor = release;
    previous?.();
  };
  const capture = () => {
    if (mode === "following") {
      readerCapturePending = false;
      anchors = [];
      releaseAnchor?.();
      releaseAnchor = undefined;
      return;
    }
    // A disclosure press, keyboard activation, or geometry notification is not
    // reader displacement and must not replace an explicitly revealed source.
    if (mode === "user-pinned" || navigation) return;
    if (leases || changing) return;
    const candidates = [...geometries.values()].flatMap((geometry) => {
      const anchor = geometry.anchor();
      if (!anchor) return [];
      const prefix = `${geometry.id}/${encodeURIComponent(anchor.key)}/`;
      // A container covering estimated descendant spacers is not a source.
      if ([...geometries.keys()].some((id) => id.startsWith(prefix))) return [];
      return [{ geometry, anchor }];
    }).sort((a, b) =>
      (a.geometry.distance?.() ?? 0) - (b.geometry.distance?.() ?? 0) ||
      b.geometry.depth - a.geometry.depth
    );
    const source = candidates[0];
    // Crossing estimated space keeps the adjacent measured attachment. Mounting
    // a guessed predecessor can never retire the source the reader just saw.
    if (!source) return;
    attach(source.geometry.id, source.anchor);
    readerCapturePending = false;
  };
  const setMode = (next: typeof mode) => {
    mode = next;
    // Every route into follow (including native movement at the tail) retires
    // anchored source retention, even while descendant geometry is pending.
    if (next === "following") capture();
  };
  const cancelNavigation = (reason = "Viewport intent superseded") => {
    const previous = restoration;
    restoration = undefined;
    previous?.abort(new DOMException(reason, "AbortError"));
    const old = navigation;
    navigation = undefined;
    old?.reject(new DOMException(reason, "AbortError"));
  };
  const cancelLatest = (reason = "Viewport intent superseded") => {
    const previous = latest;
    latest = undefined;
    if (!previous) return;
    const error = new DOMException(reason, "AbortError");
    previous.abort.abort(error);
    previous.reject(error);
  };
  function applyPosition(top: number) {
    const value = clamp(top);
    if (viewport.scrollTop !== value) {
      viewport.scrollTop = value;
      if (gesture) compensated = true;
    }
    position = viewport.scrollTop;
    notify();
  }
  const externalPosition = () => {
    const top = viewport.scrollTop, expected = clamp(position);
    if (Math.abs(top - expected) <= 1) return false;
    if (gesture) gestureMoved = true;
    position = top;
    if ((gesture || dragging) && mode === "free-scrolled") {
      const delta = top - expected;
      anchors = anchors.map(({ id, anchor }) => ({
        id,
        anchor: { key: anchor.key, offset: anchor.offset + delta },
      }));
      // Input can reach unmaterialized space before a window starts its geometry
      // barrier. Keep transfer pending until an intersecting measured source is
      // captured, even when the first capture attempt finds no mounted row.
      readerCapturePending = true;
      if (geometryPending) {
        // Reader motion is a displacement of the saved identities, even when
        // their DOM offsets have already changed in this layout transaction.
        schedule();
      } else capture();
      return false;
    }
    // Only an accepted input/intent supersedes navigation. Native clamping of
    // the old range can arrive after a reveal was requested, before it applies.
    if (
      gesture || dragging || navigation ||
      (geometryPending && (mode !== "following" || geometries.size > 0))
    ) return false;
    if (frame !== undefined) cancelAnimationFrame(frame);
    frame = undefined;
    geometryPending = false;
    cancelNavigation();
    if (mode === "user-pinned") setMode("free-scrolled");
    capture();
    return true;
  };
  const schedule = () => {
    if (!disposed && frame === undefined) frame = requestAnimationFrame(apply);
  };
  function apply() {
    if (frame !== undefined) cancelAnimationFrame(frame);
    frame = undefined;
    if (disposed || applying || changing) return;
    applying = true;
    try {
      if (externalPosition()) return;
      const appliedRevision = revision;
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
          if (!leases && target.measured && appliedRevision === revision) {
            navigation = undefined;
            geometryPending = false;
            if (request.intent === "user") {
              setMode(target.anchor ? "user-pinned" : "free-scrolled");
            }
            if (mode !== "following" && target.anchor) {
              attach(target.anchor.id, {
                key: target.anchor.key,
                offset: position - target.anchor.start,
              });
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
      if (mode === "following") applyPosition(viewport.scrollHeight);
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
      if (!leases && appliedRevision === revision) {
        geometryPending = false;
        // Input consumed during descendant measurement must transfer to the
        // newly visible measured source once compensation commits. Otherwise
        // its adjacent old source remains pinned forever after the last gesture.
        if (readerCapturePending || !anchors.length) capture();
      } else schedule();
    } finally {
      applying = false;
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
      if (dragging) setMode(atTail() ? "following" : "free-scrolled");
      else if (gesture === "toward" && (mode === "following" || atTail())) {
        setMode("following");
      }
      if (!geometryPending) capture();
      else schedule();
      if (mode === "following") schedule();
    } else if (changed && !navigation && !geometryPending) capture();
    notify();
  };
  const away = () => {
    cancelNavigation();
    cancelLatest();
    const captureNow = mode !== "free-scrolled" || !geometryPending;
    setMode("free-scrolled");
    if (captureNow) capture();
  };
  const beginGesture = (direction: "away" | "toward") => {
    gesture = direction;
    gestureMoved = false;
    compensated = false;
    if (gesture === "away") away();
    else if (mode === "user-pinned" || navigation) {
      away();
      if (atTail()) setMode("following");
    } else if (atTail()) setMode("following");
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
      setMode(atTail() ? "following" : "free-scrolled");
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
    // Compensating during animated input can make the browser end its scroll
    // sequence while the input's native displacement continues. That ending is
    // the owner's write, not the reader's; the next uncompensated one ends it.
    if (gesture && compensated) compensated = false;
    else gesture = undefined;
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
  // Flow chrome can reconcile after window rows have already committed their
  // geometry (for example paging status becoming an older-page control). Join
  // that DOM-content boundary too, rather than leaving a gap until a resize RAF.
  const mutations = new MutationObserver(() => {
    if (disposed || !flows.size) return;
    layout();
    apply();
  });
  const observeMutations = () => {
    mutations.disconnect();
    for (const flow of flows.keys()) {
      mutations.observe(flow, {
        childList: true,
        characterData: true,
        subtree: true,
      });
    }
  };
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
    following: () => mode === "following",
    input(top) {
      away();
      gesture = undefined;
      dragging = false;
      const previous = position;
      applyPosition(top);
      const delta = position - previous;
      anchors = anchors.map(({ id, anchor }) => ({
        id,
        anchor: { key: anchor.key, offset: anchor.offset + delta },
      }));
      readerCapturePending = true;
      if (!geometryPending) capture();
      setMode(atTail() ? "following" : "free-scrolled");
      layout();
    },
    snapshot: () => snapshot,
    subscribeSnapshot(change) {
      snapshotListeners.add(change);
      return () => {
        snapshotListeners.delete(change);
      };
    },
    history(value) {
      if (
        history.first === value.first && history.last === value.last &&
        history.exhausted === value.exhausted &&
        history.appendRevision === value.appendRevision
      ) return;
      if (
        mode !== "following" &&
        (value.appendRevision ?? 0) > (history.appendRevision ?? 0)
      ) newMessages = true;
      history = Object.freeze({ ...value });
      layout();
    },
    latest(ready) {
      if (latest) return latest.promise;
      if (disposed) {
        return Promise.reject(
          new DOMException("Viewport retired", "AbortError"),
        );
      }
      cancelNavigation();
      const pending = {
        ...Promise.withResolvers<void>(),
        abort: new AbortController(),
        ready: false,
      };
      latest = pending;
      // Keep the source anchor while acquiring authority. Only this intent's
      // successful readiness can release it and enter the existing follow path.
      let acquired: Promise<void>;
      try {
        acquired = ready(pending.abort.signal);
      } catch (error) {
        acquired = Promise.reject(error);
      }
      void acquired.then(() => {
        if (latest !== pending || pending.abort.signal.aborted) return;
        pending.ready = true;
        tail = true;
        setMode("following");
        gesture = undefined;
        dragging = false;
        layout();
      }).catch((error) => {
        if (latest !== pending) return;
        latest = undefined;
        pending.reject(error);
      });
      return pending.promise;
    },
    async restore(ready, apply) {
      if (disposed) return;
      cancelNavigation();
      cancelLatest();
      const controller = restoration = new AbortController();
      try {
        await ready(controller.signal);
        if (
          restoration !== controller || controller.signal.aborted || disposed
        ) return;
        // Normal measured navigation inside apply owns its own cancellation.
        // It must not retire the acquisition that has just completed itself.
        restoration = undefined;
        await apply();
      } catch (error) {
        if (!controller.signal.aborted) throw error;
      } finally {
        if (restoration === controller) restoration = undefined;
      }
    },
    follow() {
      cancelNavigation();
      cancelLatest();
      tail = true;
      setMode("following");
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
    transaction(change) {
      externalPosition();
      changing++;
      geometryPending = true;
      revision++;
      try {
        change();
      } finally {
        changing--;
        if (!changing) {
          layout();
          // Measured reconciliation and its compensation commit before paint.
          // The legacy layout intent remains queued, preserving pending native
          // notifications that predate that reconciliation.
          apply();
        }
      }
    },
    hold() {
      leases++;
      geometryPending = true;
      let live = true;
      return () => {
        if (!live) return;
        live = false;
        leases--;
        layout();
      };
    },
    register(geometry) {
      if (geometries.has(geometry.id)) {
        throw new Error(`Duplicate viewport geometry: ${geometry.id}`);
      }
      geometries.set(geometry.id, geometry);
      if (!anchors.length && mode === "free-scrolled") capture();
      layout();
      return () => {
        if (geometries.get(geometry.id) === geometry) {
          geometries.delete(geometry.id);
          if (anchors.some((saved) => saved.id === geometry.id)) {
            if (mode === "user-pinned") setMode("free-scrolled");
            anchors = [];
            const release = releaseAnchor;
            releaseAnchor = undefined;
            release?.();
            layout();
          }
        }
      };
    },
    remap(id, change) {
      const saved = anchors.find((saved) => saved.id === id);
      if (!saved) return;
      const anchor = change(saved.anchor);
      if (anchor) attach(id, anchor);
      else {
        if (mode === "user-pinned") setMode("free-scrolled");
        anchors = [];
        releaseAnchor?.();
        releaseAnchor = undefined;
      }
    },
    subscribe(change) {
      listeners.add(change);
      return () => {
        listeners.delete(change);
      };
    },
    navigate(target, { align = "nearest", intent } = {}) {
      if (disposed) {
        return Promise.reject(
          new DOMException("Viewport retired", "AbortError"),
        );
      }
      if (intent === "user") {
        cancelNavigation();
        cancelLatest();
        readerCapturePending = false;
        gesture = undefined;
        dragging = false;
      } else {
        // Layout positioning may not preempt newer reader intent or its pin.
        if (
          mode === "user-pinned" || navigation?.intent === "user" || latest ||
          restoration || gesture || dragging
        ) return Promise.resolve();
        cancelNavigation();
      }
      return new Promise<void>((resolve, reject) => {
        navigation = { target, align, intent, resolve, reject };
        layout();
      });
    },
    observe(flow) {
      flows.set(flow, (flows.get(flow) ?? 0) + 1);
      observer.observe(flow);
      observeMutations();
      layout();
      return () => {
        const count = (flows.get(flow) ?? 1) - 1;
        if (count) flows.set(flow, count);
        else {
          flows.delete(flow);
          if (flow !== viewport) observer.unobserve(flow);
          observeMutations();
        }
      };
    },
    dispose() {
      disposed = true;
      cancelNavigation("Viewport retired");
      cancelLatest("Viewport retired");
      if (frame !== undefined) cancelAnimationFrame(frame);
      observer.disconnect();
      mutations.disconnect();
      geometries.clear();
      listeners.clear();
      snapshotListeners.clear();
      flows.clear();
      anchors = [];
      releaseAnchor?.();
      releaseAnchor = undefined;
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
    snapshot: owner.snapshot,
    subscribeSnapshot: owner.subscribeSnapshot,
    history: owner.history,
    latest: owner.latest,
    restore: owner.restore,
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
