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
/** Owns only its item frames. Measurement content has no controls or registrations. */
export default function OverflowRow<T extends { key: string }>(props: {
  items: readonly T[];
  required: readonly string[];
  preferred?: readonly string[];
  measure(item: T): Element;
  children(item: () => T): Element;
  more(keys: () => readonly string[]): Element;
}): Element {
  let root!: HTMLDivElement, sizing!: HTMLSpanElement;
  const frames = new Map<string, HTMLElement>();
  const liveFrames = new Map<string, HTMLElement>();
  const [measurements, setMeasurements] = createSignal({
    available: 0,
    widths: new Map<string, number>(),
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
      const current = liveFrames.get(key)?.getBoundingClientRect().width;
      if (current) widths.set(key, current);
    }
    const css = getComputedStyle(root);
    const next = {
      available: root.getBoundingClientRect().width,
      widths,
      gap: parseFloat(css.columnGap) || 0,
      moreWidth: sizing.getBoundingClientRect().width,
    };
    setMeasurements((old) =>
      old.available === next.available && old.gap === next.gap &&
        old.moreWidth === next.moreWidth && props.items.every((item) =>
          old.widths.get(item.key) === widths.get(item.key)
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
      });
    return {
      visible: items.filter((item) => fit.visible.includes(item.key)),
      overflow: fit.overflow,
    };
  };
  const fitted = createMemo(fitSnapshot);
  const snapshot = () => gesture() ?? fitted();
  return (
    <div
      class={["otk-overflow-row", {
        "has-overflow": snapshot().overflow.length > 0,
      }]}
      ref={(e) => root = e}
      onPointerDown={() => setGesture(fitted())}
      onPointerCancel={() => setGesture(undefined)}
    >
      <div class="otk-overflow-measure" aria-hidden="true" inert>
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
        <span ref={(e) => sizing = e}>…</span>
      </div>
      <div class="otk-overflow-items">
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
              <div
                class="otk-overflow-item"
                data-overflow-key={key}
                data-pinned={props.required.includes(key) ? "true" : undefined}
                hidden={!visible()}
                inert={!visible()}
                ref={(element) => {
                  frame = element;
                  liveFrames.set(key, element);
                  observer?.observe(element);
                }}
              >
                <ContentSlot content={() => props.children(item)} />
              </div>
            );
          }}
        </For>
      </div>
      <Show when={!!snapshot().overflow.length}>
        <div class="otk-overflow-more">
          <ContentSlot content={() => props.more(() => snapshot().overflow)} />
        </div>
      </Show>
    </div>
  );
}
