// SPDX-License-Identifier: LGPL-3.0-only
import { fitOverflow } from "@otk/client";
import {
  createMemo,
  createSignal,
  type Element,
  For,
  onCleanup,
  onSettled,
  Show,
} from "solid-js";
import "./OverflowRow.css" with { type: "text" };
import ContentSlot from "./ContentSlot.tsx";
import ScrollRegion from "./ScrollRegion.tsx";
/** Owns only its item frames. Measurement content has no controls or registrations. */
export default function OverflowRow<T extends { key: string }>(props: {
  items: readonly T[];
  required: readonly string[];
  preferred?: readonly string[];
  /** Size to the items' intrinsic extent, bounded by the available space. */
  intrinsic?: boolean;
  /** Compact navigation trails fold optional items; they never grow more rows. */
  singleLine?: boolean;
  /** Ordered full -> compact-all -> aggregate fitting, never a partial trail. */
  compactMeasure?(item: T): Element;
  /** Preserve editors without replacing their live keyed control. */
  uncompacted?: readonly string[];
  /** Keep the current crumb reachable when whole first words exceed the lane. */
  reveal?: string;
  /** Readable content floor; required items reflow instead of clipping it. */
  minimumItemSize?(item: T): string;
  measure(item: T): Element;
  children(
    item: () => T,
    compact: () => boolean,
    scrolling: () => boolean,
  ): Element;
  more(keys: () => readonly string[]): Element;
}): Element {
  let root!: HTMLDivElement, sizing!: HTMLSpanElement;
  const frames = new Map<string, HTMLElement>();
  const compactFrames = new Map<string, HTMLElement>();
  const liveFrames = new Map<string, HTMLElement>();
  const [measurements, setMeasurements] = createSignal({
    available: 0,
    widths: new Map<string, number>(),
    compactWidths: undefined as Map<string, number> | undefined,
    gap: 0,
    moreWidth: 0,
  });
  let observer: ResizeObserver | undefined;
  const [gesture, setGesture] = createSignal<ReturnType<typeof fitSnapshot>>();
  const measure = () => {
    const widths = new Map(
      [...frames].map((
        [key, element],
      ) => [key, element.getBoundingClientRect().width]),
    );
    for (const key of props.required) {
      // In a progressive row only editors can exceed their measured title.
      if (props.compactMeasure && !props.uncompacted?.includes(key)) continue;
      const current = liveFrames.get(key)?.getBoundingClientRect().width;
      // A required item may already have shrunk to make room for its optional
      // neighbours. Feeding that compressed width back into fitting lets those
      // neighbours permanently squeeze it to zero. Reserve its natural width
      // (or a larger live editor) before deciding which optional items fit.
      if (current) widths.set(key, Math.max(widths.get(key) ?? 0, current));
    }
    const css = getComputedStyle(root);
    const compactWidths = props.compactMeasure
      ? new Map(
        [...compactFrames].map((
          [key, element],
        ) => [key, element.getBoundingClientRect().width]),
      )
      : undefined;
    for (const key of props.uncompacted ?? []) {
      if (compactWidths) compactWidths.set(key, widths.get(key) ?? 0);
    }
    const next = {
      available: root.getBoundingClientRect().width,
      widths,
      compactWidths,
      gap: parseFloat(css.columnGap) || 0,
      moreWidth: sizing.getBoundingClientRect().width,
    };
    setMeasurements((old) =>
      old.available === next.available &&
        old.gap === next.gap &&
        old.moreWidth === next.moreWidth && props.items.every((item) =>
          old.widths.get(item.key) === widths.get(item.key) &&
          old.compactWidths?.get(item.key) === next.compactWidths?.get(item.key)
        )
        ? old
        : next
    );
  };
  onSettled(() => {
    observer = new ResizeObserver(measure);
    observer.observe(root);
    observer.observe(sizing);
    for (const frame of frames.values()) observer.observe(frame);
    for (const frame of compactFrames.values()) observer.observe(frame);
    for (const frame of liveFrames.values()) observer.observe(frame);
    let active = true;
    void document.fonts.ready.then(() => {
      if (active) measure();
    });
    measure();
    const outside = (event: PointerEvent) => {
      if (
        event.type === "pointercancel" || !root.contains(event.target as Node)
      ) {
        setGesture(undefined);
      }
    };
    document.addEventListener("pointerup", outside, true);
    document.addEventListener("pointercancel", outside, true);
    const clicked = () => queueMicrotask(() => setGesture(undefined));
    document.addEventListener("click", clicked, true);
    return () => {
      active = false;
      observer?.disconnect();
      document.removeEventListener("pointerup", outside, true);
      document.removeEventListener("pointercancel", outside, true);
      document.removeEventListener("click", clicked, true);
    };
  });
  const fitSnapshot = () => {
    const items = props.items,
      fit = fitOverflow({
        ...measurements(),
        keys: items.map((item) => item.key),
        required: props.required,
        preferred: props.preferred,
        scrollRequired: props.singleLine,
      });
    const reveal = props.reveal;
    if (reveal) {
      queueMicrotask(() =>
        liveFrames.get(reveal)?.scrollIntoView({
          inline: fit.mode === "scroll" ? "end" : "nearest",
          block: "nearest",
        })
      );
    }
    return {
      visible: items.filter((item) => fit.visible.includes(item.key)),
      overflow: fit.overflow,
      mode: fit.mode,
      widths: fit.widths,
    };
  };
  const fitted = createMemo(fitSnapshot);
  const snapshot = () => gesture() ?? fitted();
  return (
    <div
      class={["otk-overflow-row", {
        "has-overflow": snapshot().overflow.length > 0,
        "is-intrinsic": props.intrinsic === true,
        "is-single-line": props.singleLine === true,
        "is-compact": snapshot().mode === "compact" ||
          snapshot().mode === "collapsed",
        "is-progressive": !!props.compactMeasure,
        "is-paged": snapshot().mode === "scroll",
      }]}
      data-fit-mode={snapshot().mode}
      ref={(e) => root = e}
      onPointerDown={() => setGesture(fitted())}
      onPointerCancel={() => setGesture(undefined)}
    >
      <div
        class="otk-overflow-measure"
        aria-hidden="true"
        inert
      >
        <For each={props.items} keyed={(item) => item.key}>
          {(item) => {
            let element: HTMLElement;
            onCleanup(() => {
              if (element) observer?.unobserve(element);
              frames.delete(item().key);
            });
            return (
              <span
                ref={(frame) => {
                  element = frame;
                  frames.set(item().key, frame);
                  observer?.observe(frame);
                }}
              >
                {props.measure(item())}
              </span>
            );
          }}
        </For>
        <span ref={(e) => sizing = e}>...</span>
      </div>
      <Show when={props.compactMeasure}>
        <div class="otk-overflow-compact-measure" aria-hidden="true" inert>
          <For each={props.items} keyed={(item) => item.key}>
            {(item) => {
              let element: HTMLElement;
              onCleanup(() => {
                if (element) observer?.unobserve(element);
                compactFrames.delete(item().key);
              });
              return (
                <span
                  ref={(frame) => {
                    element = frame;
                    compactFrames.set(item().key, frame);
                    observer?.observe(frame);
                  }}
                >
                  {props.compactMeasure!(item())}
                </span>
              );
            }}
          </For>
        </div>
      </Show>
      <ScrollRegion
        axis="x"
        frameClass="otk-overflow-lane"
        class="otk-overflow-items"
        borrowed={!props.compactMeasure || !props.singleLine}
      >
        <For each={props.items} keyed={(item) => item.key}>
          {(item) => {
            const key = item().key;
            let frame: HTMLElement;
            onCleanup(() => {
              if (frame) observer?.unobserve(frame);
              liveFrames.delete(key);
            });
            const visible = () =>
              snapshot().visible.some((value) => value.key === key);
            return (
              <>
                <div
                  class="otk-overflow-item"
                  data-overflow-key={key}
                  data-pinned={props.required.includes(key)
                    ? "true"
                    : undefined}
                  style={{
                    "min-inline-size": props.compactMeasure
                      ? undefined
                      : props.minimumItemSize?.(item()),
                    "--overflow-item-width":
                      snapshot().widths?.get(key) === undefined
                        ? undefined
                        : `${snapshot().widths!.get(key)}px`,
                  }}
                  hidden={!visible()}
                  inert={!visible()}
                  ref={(element) => {
                    frame = element;
                    liveFrames.set(key, element);
                    observer?.observe(element);
                  }}
                >
                  <ContentSlot
                    content={() =>
                      props.children(
                        item,
                        () => snapshot().mode === "compact" ||
                          snapshot().mode === "collapsed",
                        () => snapshot().mode === "scroll",
                      )}
                  />
                </div>
              </>
            );
          }}
        </For>
      </ScrollRegion>
      <Show when={!!snapshot().overflow.length}>
        <div class="otk-overflow-more">
          <ContentSlot content={() => props.more(() => snapshot().overflow)} />
        </div>
      </Show>
    </div>
  );
}
