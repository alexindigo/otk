// SPDX-License-Identifier: LGPL-3.0-only
import "./ScrollRegion.css" with { type: "text" };
import { type ComponentProps, dynamic } from "@solidjs/web";
import {
  createSignal,
  createUniqueId,
  type Element,
  onSettled,
  untrack,
} from "solid-js";
import { nativeAttributes } from "./native-attributes.ts";
import { acquireViewport, type ViewportPosition } from "./viewport.ts";
import { scrollbarGeometry, scrollbarPosition } from "./scrollbar.ts";

export type ScrollAxis = "both" | "x" | "y";
export type ScrollbarPaint = "otk" | "native" | "thin" | "hidden";

/** Native elements borrow the same scroll policy without adding a wrapper. */
export function scrollRegion(
  axis: ScrollAxis = "both",
  scrollbar: ScrollbarPaint = "otk",
): string {
  return `otk-scroll${axis === "both" ? "" : ` otk-scroll-${axis}`}${
    scrollbar === "hidden" ? " otk-scrollbar-hidden" : " otk-scrollbar-otk"
  }`;
}

/** Scroll ownership, independent of content, geometry and position owners. */
export default function ScrollRegion<
  T extends "div" | "section" | "pre" | "textarea" | "ul" = "div",
>(
  props: Omit<ComponentProps<T>, "class"> & {
    as?: T;
    class?: ComponentProps<"div">["class"];
    frameClass?: string;
    /** Borrowed windows are flow content, not a second scroll boundary. */
    borrowed?: boolean;
    axis?: ScrollAxis;
    scrollbar?: ScrollbarPaint;
    /** For horizontal-only lanes: reveal the track in its own row on overflow. */
    horizontalTrack?: "in-flow";
  },
): Element {
  // The dynamic tag preserves T at the public boundary. Native event/ref types
  // are consumed by this binding, not passed to a union of intrinsic tags.
  const native = nativeAttributes<Record<string, unknown>>(() => props, [
    "children",
    "class",
    "axis",
    "scrollbar",
    "as",
    "frameClass",
    "borrowed",
    "horizontalTrack",
  ]);
  const Tag = dynamic(() => props.as ?? "div");
  const field = untrack(() => props.as === "textarea");
  const Frame = dynamic(() => field ? "span" : "div");
  const id = createUniqueId();
  let viewport!: HTMLElement, owner: ViewportPosition | undefined;
  const [metrics, setMetrics] = createSignal({
    top: 0,
    height: 0,
    content: 0,
    left: 0,
    width: 0,
    wide: 0,
  });
  const [active, setActive] = createSignal(false);
  const [dragging, setDragging] = createSignal(false);
  let idle: ReturnType<typeof setTimeout> | undefined;
  const wake = () => {
    setActive(true);
    clearTimeout(idle);
    idle = setTimeout(() => setActive(false), 1200);
  };
  onSettled(() => {
    if (props.borrowed) return;
    const lease = acquireViewport(viewport);
    owner = lease.owner;
    const update = () => {
      const committed = owner!.snapshot();
      // Revision zero precedes the first measurement transaction. Do not paint
      // a provisional virtual estimate while descendant leases are still held.
      if (!committed.revision) return;
      setMetrics({
        top: committed.scrollTop,
        height: committed.viewportHeight,
        content: committed.contentHeight,
        left: viewport.scrollLeft,
        width: viewport.clientWidth,
        wide: viewport.scrollWidth,
      });
    };
    const release = owner.subscribeSnapshot(update);
    // Nonvirtual flow has no measurement transaction; the same position owner
    // commits its changing extents. Virtual descendants retain their barriers.
    const flow = owner.observe(viewport);
    const scroll = () => {
      update();
      wake();
    };
    viewport.addEventListener("scroll", scroll, { passive: true });
    update();
    return () => {
      clearTimeout(idle);
      release();
      flow();
      lease.release();
      viewport.removeEventListener("scroll", scroll);
      owner = undefined;
    };
  });
  function Bar(input: { axis: "x" | "y" }) {
    let track!: HTMLDivElement;
    const [length, setLength] = createSignal(0);
    const horizontal = input.axis === "x";
    const values = () =>
      horizontal
        ? {
          view: metrics().width,
          content: metrics().wide,
          position: metrics().left,
        }
        : {
          view: metrics().height,
          content: metrics().content,
          position: metrics().top,
        };
    const geometry = () => {
      const m = values();
      return scrollbarGeometry(m.view, m.content, m.position, length());
    };
    const coordinate = (event: PointerEvent) =>
      horizontal ? event.clientX : event.clientY;
    let drag: { id: number; start: number; offset: number } | undefined;
    const apply = (offset: number) => {
      const m = values(),
        position = scrollbarPosition(offset, m.view, m.content, length());
      if (horizontal) viewport.scrollLeft = position;
      else owner?.input(position);
      wake();
    };
    const end = (event: PointerEvent) => {
      if (drag?.id !== event.pointerId) return;
      drag = undefined;
      setDragging(false);
      if (track.hasPointerCapture(event.pointerId)) {
        track.releasePointerCapture(event.pointerId);
      }
      wake();
    };
    onSettled(() => {
      const resize = new ResizeObserver(() =>
        setLength(horizontal ? track.clientWidth : track.clientHeight)
      );
      resize.observe(track);
      setLength(horizontal ? track.clientWidth : track.clientHeight);
      return () => resize.disconnect();
    });
    return (
      <div
        ref={track}
        class={["otk-scroll-track", `otk-scroll-track-${input.axis}`]}
        role="scrollbar"
        aria-controls={props.id ?? id}
        aria-label={horizontal ? "Horizontal scroll" : "Vertical scroll"}
        aria-orientation={horizontal ? "horizontal" : "vertical"}
        aria-valuemin={0}
        aria-valuemax={geometry().maximum}
        aria-valuenow={values().position}
        hidden={props.scrollbar === "hidden" || !geometry().maximum ||
          (props.axis === "x" && !horizontal) ||
          (props.axis === "y" && horizontal)}
        onPointerDown={(event: PointerEvent) => {
          if (event.button !== 0) return;
          event.preventDefault();
          const rect = track.getBoundingClientRect();
          const point = coordinate(event) - (horizontal ? rect.left : rect.top);
          const thumb = geometry();
          if (point < thumb.offset || point > thumb.offset + thumb.size) {
            apply(point - thumb.size / 2);
          }
          drag = {
            id: event.pointerId,
            start: coordinate(event),
            offset: geometry().offset,
          };
          track.setPointerCapture(event.pointerId);
          setDragging(true);
          wake();
        }}
        onPointerMove={(event: PointerEvent) => {
          if (drag?.id === event.pointerId) {
            apply(
              drag.offset + coordinate(event) - drag.start,
            );
          }
        }}
        onPointerUp={end}
        onPointerCancel={end}
        onLostPointerCapture={end}
        onWheel={(event: WheelEvent) => {
          if (event.ctrlKey || event.metaKey) return;
          event.preventDefault();
          const m = values();
          const unit = event.deltaMode === 2
            ? m.view
            : event.deltaMode === 1
            ? parseFloat(getComputedStyle(viewport).lineHeight) || 1
            : 1;
          const next = m.position +
            (horizontal ? event.deltaX || event.deltaY : event.deltaY) * unit;
          if (horizontal) viewport.scrollLeft = next;
          else owner?.input(next);
          wake();
        }}
      >
        <div
          class="otk-scroll-thumb"
          style={horizontal
            ? {
              width: `${geometry().size}px`,
              transform: `translateX(${geometry().offset}px)`,
            }
            : {
              height: `${geometry().size}px`,
              transform: `translateY(${geometry().offset}px)`,
            }}
        />
      </div>
    );
  }
  const content = () => (
    <Tag
      {...native.attributes}
      id={props.id ?? id}
      ref={[
        props.ref as ComponentProps<"div">["ref"],
        native.ref,
        (element: HTMLElement) => viewport = element,
      ]}
      class={[
        !props.borrowed && scrollRegion(props.axis, props.scrollbar),
        props.class,
      ]}
    >
      {props.children}
    </Tag>
  );
  if (untrack(() => props.borrowed)) return content();
  return (
    <Frame
      class={["otk-scroll-frame", props.frameClass, {
        "otk-scroll-field": field,
        "has-in-flow-track": props.axis === "x" &&
          props.horizontalTrack === "in-flow",
        "is-scrolling": active(),
        "is-dragging": dragging(),
      }]}
      hidden={props.hidden}
    >
      {content()}
      <Bar axis="y" />
      <Bar axis="x" />
    </Frame>
  );
}
